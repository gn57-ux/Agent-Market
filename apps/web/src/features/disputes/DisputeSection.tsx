import { useEffect, useRef, useState } from "react";
import { keccak256, toBytes } from "viem";
import { useSession } from "../session/SessionProvider.js";
import { useWallet } from "../wallet/WalletProvider.js";
import { ApiError, getTask, type TaskRecord } from "../tasks/api.js";
import { getDispute, submitDisputeResolveVerification, type DisputeRecord } from "./api.js";
import { ActionSheet } from "../../shared/action-sheet/ActionSheet.js";
import { ConfirmAction } from "../../shared/components/ConfirmAction.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow, type VerifyOutcome } from "../../shared/tx-flow/useTransactionFlow.js";
import { DisputeOpenForm } from "./DisputeOpenForm.js";
import { TASK_ESCROW_RESOLVE_DISPUTE_ABI } from "./abi.js";

export interface DisputeSectionProps {
  taskId: string;
  onTaskChanged?: () => void;
}

const SECTION_CLASSES = "mt-8 rounded-card border border-divider-light bg-surface-light p-6 md:p-8";

/** Same derivation `SettlementSection.tsx`/`SubmissionSection.tsx` mirror
 * from `apps/api`'s `onchain-task-id.ts`. Re-declared locally rather than
 * imported from `settlement/`: the two features have no shared module and
 * this is a pure, stable one-liner — not worth a cross-feature dependency
 * for. */
function deriveOnChainTaskId(taskId: string): `0x${string}` {
  return keccak256(toBytes(taskId));
}

/**
 * The shared mutual-exclusion rule for the two arbitration resolve actions
 * (`resolveDispute(taskId, true)` / `resolveDispute(taskId, false)`) —
 * structurally the SAME "which statuses of the OTHER flow should block this
 * one from starting" rule `SettlementSection.tsx`'s
 * `flowBlocksOtherSettlementAction` establishes for `approveResult`/
 * `finalizeReviewTimeout` (T-1004, human review round 3): `resolveDispute`
 * is a one-shot, mutually exclusive terminal call, so the same reasoning
 * applies verbatim. Deliberately NOT imported from `settlement/` (that file
 * is already human-approved under its own Task lineage; this Task keeps its
 * own copy rather than risk destabilizing an already-approved artifact) —
 * kept here as this module's OWN single definition, called from both
 * directions below, never duplicated per button.
 */
function flowBlocksOtherResolveAction(
  flow: ReturnType<typeof useTransactionFlow>,
  isKnownRevertedPending: boolean,
): boolean {
  switch (flow.status.kind) {
    case "awaitingSignature":
    case "pending":
    case "confirming":
    case "verifying":
      return true;
    case "rpcRecoveryPending":
      return !isKnownRevertedPending;
    case "idle":
    case "failed":
    case "confirmed":
      return false;
  }
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; task: TaskRecord; dispute: DisputeRecord | null }
  | { status: "error"; message: string };

/**
 * Codex review (T-1007 round 1, P2 — routed to T-1005's own lineage): the
 * SUBMITTED/RELEASED/REFUNDED "no dispute yet" case is a 404 specifically
 * — a real 401/403/500, a network failure, or any other error must still
 * surface as this component's own `error` state, never be silently
 * reinterpreted as "this task was never disputed" (which would hide a
 * real backend failure, or a real already-resolved arbitration outcome,
 * behind a misleadingly empty dispute section). Centralized here so both
 * call sites apply the exact same narrow catch, rather than each
 * re-deciding which errors are safe to swallow.
 */
function fetchDisputeAllowing404(taskId: string): Promise<DisputeRecord | null> {
  return getDispute(taskId).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
}

/**
 * T-1005: accepts Feature 6 `TaskDetailSections.tsx`'s `SUBMITTED`/
 * `DISPUTED` cases (AC-1009's dispute half).
 *
 * - `SUBMITTED`: the requester (F-1003, requester-only, strictly before
 *   `reviewDeadline` — enforced on-chain by `openDispute` itself, this UI
 *   does not duplicate that deadline check) sees a "发起争议" trigger that
 *   opens `DisputeOpenForm` in an `ActionSheet` (F-1008).
 * - `DISPUTED`: fetches the dispute record. The requester sees a read-only
 *   status view (their own submitted reason, and the resolution once set).
 *   Any OTHER signed-in viewer sees the "arbitration view" — the evidence
 *   the backend's access guard chose to reveal, plus two `ConfirmAction`
 *   resolve buttons. Per design.md's explicit interface contract ("仲裁裁决
 *   接口不新增权限校验层——链上 ARBITRATOR_ROLE 是唯一权威校验，后端只负责展示
 *   证据和同步结果，不做链下二次授权"), this view does NOT attempt to verify
 *   the connected wallet actually holds `ARBITRATOR_ROLE` before rendering
 *   the resolve buttons — a non-arbitrator's signed transaction simply
 *   reverts on-chain, surfaced through the same revert/retry handling as
 *   any other flow here. There is no third "accepted agent" view: the
 *   agent sees the same arbitration-view shape as any other non-requester,
 *   matching design.md's literal two-way split.
 */
export function DisputeSection({ taskId, onTaskChanged }: DisputeSectionProps) {
  const session = useSession();
  const wallet = useWallet();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [sheetOpen, setSheetOpen] = useState(false);
  // See `SettlementSection.tsx`'s `revertedHashesRef` for the full
  // rationale — shared across both resolve flows since tx hashes are
  // globally unique.
  const revertedHashesRef = useRef<Set<string>>(new Set());

  function reload() {
    let ignore = false;
    setState({ status: "loading" });
    getTask(taskId)
      .then((task): Promise<{ task: TaskRecord; dispute: DisputeRecord | null }> => {
        // Codex review (T-1005 round 1, P1): `resolveDispute` moves the task
        // straight from DISPUTED to RELEASED/REFUNDED — the arbitration
        // outcome must still be readable there, not only while the task is
        // still (transiently) DISPUTED. RELEASED/REFUNDED is also the
        // far-more-common "settled without ever disputing" case, so a 404
        // there is the ordinary outcome, not an anomaly (same "each section
        // falls back gracefully rather than failing the whole load"
        // convention `SettlementSection.tsx`'s `reviewDeadline` fetch
        // uses) — unlike DISPUTED, where a missing dispute record IS a
        // genuine anomaly (a dispute is a prerequisite to reach that
        // status), so it is NOT swallowed there.
        if (task.status === "DISPUTED") {
          return getDispute(taskId).then((dispute) => ({ task, dispute }));
        }
        if (task.status === "RELEASED" || task.status === "REFUNDED") {
          return fetchDisputeAllowing404(taskId).then((dispute) => ({ task, dispute }));
        }
        // Codex review (T-1007 round 1, P1 — routed to T-1005's own
        // lineage): a SUBMITTED task may already have a dispute saved
        // off-chain (`POST /tasks/:taskId/disputes` succeeded) but never
        // broadcast on-chain (`openDispute`) — the user closed the tab,
        // lost their wallet connection, or simply refreshed before
        // signing. Fetching it here (same 404-only-means-"none-yet"
        // treatment as RELEASED/REFUNDED above) is what lets
        // `DisputeOpenForm` resume from that saved evidence hash instead
        // of silently discarding it and dead-ending on a guaranteed 409
        // if the user tried to save again.
        if (task.status === "SUBMITTED") {
          return fetchDisputeAllowing404(taskId).then((dispute) => ({ task, dispute }));
        }
        return Promise.resolve({ task, dispute: null });
      })
      .then((result) => {
        if (!ignore) setState({ status: "ready", ...result });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载争议信息失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }

  useEffect(reload, [taskId]);

  async function confirmOnChain(txHash: `0x${string}`): Promise<{ confirmations: number }> {
    const publicClient = wallet.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      revertedHashesRef.current.add(txHash);
      throw new Error("链上交易执行失败（已回滚），请点击重试以重新发起。");
    }
    return { confirmations: 1 };
  }

  async function verifyResolve(txHash: `0x${string}`): Promise<VerifyOutcome> {
    try {
      const result = await submitDisputeResolveVerification(taskId, txHash);
      if ("status" in result) {
        return { outcome: "confirmed" };
      }
      return { outcome: "rpcUnavailable", error: result.error.message };
    } catch (error) {
      if (error instanceof ApiError && error.code) {
        return { outcome: "rejected", errorCode: error.code };
      }
      throw error;
    }
  }

  function buildResolveTx(supportAgent: boolean): () => Promise<{ hash: `0x${string}` }> {
    return async () => {
      if (!wallet.address) throw new Error("请先连接 MetaMask 钱包。");
      const walletClient = wallet.getWalletClient();
      const hash = await walletClient.writeContract({
        address: wallet.chainConfig.addresses.taskEscrow,
        abi: TASK_ESCROW_RESOLVE_DISPUTE_ABI,
        functionName: "resolveDispute",
        args: [deriveOnChainTaskId(taskId), supportAgent],
        account: wallet.address,
        chain: null,
      });
      return { hash };
    };
  }

  const supportAgentFlow = useTransactionFlow({
    buildTx: buildResolveTx(true),
    confirm: confirmOnChain,
    verify: verifyResolve,
  });
  const supportRequesterFlow = useTransactionFlow({
    buildTx: buildResolveTx(false),
    confirm: confirmOnChain,
    verify: verifyResolve,
  });

  async function runResolve(flow: ReturnType<typeof useTransactionFlow>) {
    const result = await flow.start();
    if (result.outcome === "confirmed") {
      reload();
      onTaskChanged?.();
    }
  }

  async function runResolveRetry(flow: ReturnType<typeof useTransactionFlow>) {
    const isKnownRevertedHash =
      flow.status.kind === "rpcRecoveryPending" &&
      revertedHashesRef.current.has(flow.status.txHash);
    const result = isKnownRevertedHash ? await flow.start() : await flow.retry();
    if (result.outcome === "confirmed") {
      reload();
      onTaskChanged?.();
    }
  }

  function isKnownRevertedPending(flow: ReturnType<typeof useTransactionFlow>): boolean {
    return (
      flow.status.kind === "rpcRecoveryPending" && revertedHashesRef.current.has(flow.status.txHash)
    );
  }

  if (state.status === "loading") {
    return (
      <div className={SECTION_CLASSES}>
        <p className="text-body text-ink-secondary">加载中…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={SECTION_CLASSES}>
        <p role="alert" className="text-body text-warning">
          {state.message}
        </p>
      </div>
    );
  }

  const { task, dispute } = state;
  const isRequester =
    session.status === "signed_in" &&
    !!session.address &&
    session.address.toLowerCase() === task.requesterAddress.toLowerCase();
  const walletIsRequester =
    !!wallet.address && wallet.address.toLowerCase() === task.requesterAddress.toLowerCase();
  const isSignedIn = session.status === "signed_in";

  if (task.status === "SUBMITTED") {
    if (!isRequester) return null;
    // Codex review (T-1007 round 1, P1 — routed to T-1005's own lineage):
    // `dispute` here can only ever be an OPEN dispute saved off-chain but
    // never broadcast on-chain (a RESOLVED dispute implies the task has
    // already moved to RELEASED/REFUNDED, which this branch never reaches
    // — see the SUBMITTED-only `getTask` check above). Its `evidenceHash`
    // is guaranteed present for the requester (the backend's access guard
    // always grants the requester "full" access, per `access-guard.ts`'s
    // own three-participant rule) — the `dispute.evidenceHash` guard below
    // is defensive, not an expected-absent case.
    const existingDispute =
      dispute && dispute.evidenceHash
        ? { disputeId: dispute.disputeId, evidenceHash: dispute.evidenceHash }
        : undefined;
    return (
      <div className={SECTION_CLASSES}>
        <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">争议</h2>
        <p className="mb-3 text-caption text-ink-secondary">
          {existingDispute
            ? "争议信息已保存，尚未完成链上提交，可继续完成签名和广播。"
            : "如果对交付成果有异议，可在验收截止时间前发起争议，交由仲裁裁决。"}
        </p>
        <button
          type="button"
          disabled={!isSignedIn || !walletIsRequester || !wallet.isCorrectNetwork}
          onClick={() => setSheetOpen(true)}
          className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {existingDispute ? "继续提交争议" : "发起争议"}
        </button>
        <ActionSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          titleForA11y="发起争议"
          content={
            <DisputeOpenForm
              taskId={taskId}
              existingDispute={existingDispute}
              onOpened={() => {
                setSheetOpen(false);
                reload();
                onTaskChanged?.();
              }}
            />
          }
        />
      </div>
    );
  }

  // No dispute record at all: either an unrelated status (ACCEPTED etc,
  // not this component's case per `TaskDetailSections.tsx`), or RELEASED/
  // REFUNDED reached through ordinary settlement (`approveResult`/
  // `finalizeReviewTimeout`) — never disputed, nothing for this section to
  // show.
  if (!dispute) return null;

  if (isRequester) {
    return (
      <div className={SECTION_CLASSES}>
        <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">争议</h2>
        <p className="text-caption text-ink-secondary">
          争议原因：<span className="text-ink-primary">{dispute.reason}</span>
        </p>
        {dispute.status === "OPEN" ? (
          <p className="mt-2 text-caption text-ink-secondary">仲裁处理中，请等待裁决结果。</p>
        ) : (
          <p className="mt-2 text-caption text-ink-primary">
            仲裁已裁决：
            {dispute.resolution === "SUPPORT_AGENT"
              ? "支持 Agent，预算和质押已放款给 Agent。"
              : "支持需求方，预算和质押已退还给需求方。"}
          </p>
        )}
      </div>
    );
  }

  // Arbitration view — any other signed-in viewer. The evidence fields are
  // present only when the backend's access guard granted this session full
  // access (see `DisputeRecord`'s own comment); absent means this viewer
  // cannot see the evidence, but the resolve buttons still render per
  // design.md's "on-chain role check is the only authority" decision.
  //
  // The outcome message must not wait on `reload()`'s own backend refetch
  // to catch up (same convention `SettlementSection.tsx`'s `settled` uses
  // for `approveFlow`/`finalizeTimeoutFlow`) — the ON-CHAIN confirmation is
  // itself the ground truth the moment either flow reaches `confirmed`,
  // independent of how quickly the dispute record's own projection catches
  // up.
  const localResolution: DisputeRecord["resolution"] =
    supportAgentFlow.status.kind === "confirmed"
      ? "SUPPORT_AGENT"
      : supportRequesterFlow.status.kind === "confirmed"
        ? "SUPPORT_REQUESTER"
        : null;
  const resolution = dispute.resolution ?? localResolution;
  // Codex review (T-1005 round 1, P1): once `resolveDispute` confirms, the
  // task moves straight from DISPUTED to RELEASED/REFUNDED — the resolve
  // buttons must never render for either of those (there is nothing left
  // to arbitrate; `resolveDispute` is one-shot and would just revert), only
  // the read-only outcome below. `task.status !== "DISPUTED"` covers that
  // case even before `dispute.status`/`localResolution` have caught up.
  const settled =
    task.status !== "DISPUTED" || dispute.status === "RESOLVED" || localResolution !== null;
  return (
    <div className={SECTION_CLASSES}>
      <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">争议仲裁</h2>
      <p className="text-caption text-ink-secondary">
        争议原因：<span className="text-ink-primary">{dispute.reason}</span>
      </p>
      {dispute.evidenceSummary && (
        <p className="mt-2 text-caption text-ink-secondary">
          证据说明：<span className="text-ink-primary">{dispute.evidenceSummary}</span>
        </p>
      )}

      {settled ? (
        <p className="mt-4 text-caption text-success">
          仲裁已裁决：
          {resolution === "SUPPORT_AGENT" ? "支持 Agent。" : "支持需求方。"}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <ConfirmAction
              label="支持 Agent"
              confirmLabel="确认支持 Agent？"
              disabled={
                !isSignedIn ||
                !wallet.isCorrectNetwork ||
                supportAgentFlow.status.kind !== "idle" ||
                flowBlocksOtherResolveAction(
                  supportRequesterFlow,
                  isKnownRevertedPending(supportRequesterFlow),
                )
              }
              onConfirm={() => void runResolve(supportAgentFlow)}
            />
            <TransactionStatusView status={supportAgentFlow.status} />
            {(supportAgentFlow.status.kind === "rpcRecoveryPending" ||
              supportAgentFlow.status.kind === "failed") && (
              <button
                type="button"
                disabled={
                  (supportAgentFlow.status.kind === "failed" ||
                    isKnownRevertedPending(supportAgentFlow)) &&
                  (!isSignedIn || !wallet.isCorrectNetwork)
                }
                onClick={() => void runResolveRetry(supportAgentFlow)}
                className="rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
              >
                重试
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <ConfirmAction
              label="支持需求方"
              confirmLabel="确认支持需求方？"
              disabled={
                !isSignedIn ||
                !wallet.isCorrectNetwork ||
                supportRequesterFlow.status.kind !== "idle" ||
                flowBlocksOtherResolveAction(
                  supportAgentFlow,
                  isKnownRevertedPending(supportAgentFlow),
                )
              }
              onConfirm={() => void runResolve(supportRequesterFlow)}
            />
            <TransactionStatusView status={supportRequesterFlow.status} />
            {(supportRequesterFlow.status.kind === "rpcRecoveryPending" ||
              supportRequesterFlow.status.kind === "failed") && (
              <button
                type="button"
                disabled={
                  (supportRequesterFlow.status.kind === "failed" ||
                    isKnownRevertedPending(supportRequesterFlow)) &&
                  (!isSignedIn || !wallet.isCorrectNetwork)
                }
                onClick={() => void runResolveRetry(supportRequesterFlow)}
                className="rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
              >
                重试
              </button>
            )}
          </div>

          {!isSignedIn && (
            <p role="alert" className="text-caption text-warning">
              请先登录后再发起裁决交易（结果复核需要登录后才能提交）。
            </p>
          )}
          {!wallet.isCorrectNetwork && (
            <p role="alert" className="text-caption text-warning">
              当前网络不正确，请先切换到 {wallet.chainConfig.name} 后再发起交易。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
