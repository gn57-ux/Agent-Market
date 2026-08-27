import { useEffect, useRef, useState } from "react";
import { keccak256, toBytes } from "viem";
import { useSession } from "../session/SessionProvider.js";
import { useWallet } from "../wallet/WalletProvider.js";
import { ApiError, getTask, submitSettlementVerification, type TaskRecord } from "../tasks/api.js";
import { getLatestDeliverable } from "../deliverables/api.js";
import { RatingSection } from "../ratings/RatingSection.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow, type VerifyOutcome } from "../../shared/tx-flow/useTransactionFlow.js";
import { TASK_ESCROW_SETTLEMENT_ABI } from "./abi.js";

export interface SettlementSectionProps {
  taskId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; task: TaskRecord; reviewDeadline: string | null }
  | { status: "error"; message: string };

const SECTION_CLASSES = "mt-8 rounded-card border border-divider-light bg-surface-light p-6 md:p-8";

/** Same derivation `SubmissionSection.tsx`/`AcceptConfirmContent.tsx` mirror
 * from `apps/api`'s `onchain-task-id.ts` — a pure, permanently-stable
 * function of the UUID, recomputed here rather than added to any response
 * contract. */
function deriveOnChainTaskId(taskId: string): `0x${string}` {
  return keccak256(toBytes(taskId));
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function isPast(value: string | null): boolean {
  return !!value && Date.parse(value) <= Date.now();
}

/**
 * The ONE shared rule for whether one settlement flow's CURRENT status
 * should block a conflicting settlement action from starting (Codex
 * review, T-1004 human review round 3, P2 — fixing round 2's own P2 fix,
 * which used a blanket `flow.status.kind !== "idle"` and over-blocked two
 * cases that can never actually conflict: a `failed` attempt (the
 * signature/broadcast never reached the chain at all — nothing to
 * conflict with) and a `rpcRecoveryPending` status whose hash is already
 * KNOWN to have reverted (see `revertedHashesRef` — a confirmed revert can
 * never later succeed, so it can never conflict with anything either). In
 * both of those cases the user was stuck unable to try the OTHER
 * settlement action even though nothing was actually still in flight —
 * only a page refresh (discarding local state) "fixed" it, which is not a
 * real state model.
 *
 * Defined ONCE and called from both directions in `SubmittedView` — never
 * duplicate this switch per button.
 */
function flowBlocksOtherSettlementAction(
  flow: ReturnType<typeof useTransactionFlow>,
  isKnownRevertedPending: boolean,
): boolean {
  switch (flow.status.kind) {
    case "awaitingSignature":
    case "pending":
    case "confirming":
    case "verifying":
      // A signature is about to happen, or a broadcast transaction's
      // outcome isn't known yet — it could still succeed, so a conflicting
      // action must not start.
      return true;
    case "rpcRecoveryPending":
      // The transaction WAS broadcast and its outcome is still unclear
      // (an RPC hiccup or a transient verification failure, NOT a
      // confirmed revert) — same "could still succeed" reasoning as
      // above, UNLESS we've already confirmed it reverted, in which case
      // there is no ambiguity left and nothing to block.
      return !isKnownRevertedPending;
    case "idle":
    case "failed":
    case "confirmed":
      // idle: nothing attempted. failed: the signature/broadcast itself
      // never reached the chain — no possible future success to conflict
      // with. confirmed: already settled (this whole view stops rendering
      // once either flow reaches this, via `settled` below).
      return false;
  }
}

/**
 * T-1004: accepts Feature 6 `TaskDetailSections.tsx`'s `ACCEPTED`/
 * `SUBMITTED`/`RELEASED`/`REFUNDED` cases via a one-line import + case
 * (AC-1009) — fetches its own `TaskRecord` (and, once a deliverable
 * exists, its `reviewDeadline` via `deliverables/api.ts`'s
 * `getLatestDeliverable`, same "each section fetches its own data"
 * convention `SubmissionSection`/`AcceptanceSection`/`FundingSection`
 * already establish).
 *
 * Renders per status (design.md's own interface contract):
 * - `ACCEPTED`: shows the delivery deadline; once passed, the requester
 *   may `claimDeliveryTimeout` (F-1002).
 * - `SUBMITTED`: the requester may `approveResult` at any time; once
 *   `reviewDeadline` has passed, any SIGNED-IN wallet may
 *   `finalizeReviewTimeout` (F-1002 — the on-chain call itself is
 *   permissionless, but `POST /tasks/:taskId/settlement-verifications`
 *   requires a session regardless of who called the contract, so this
 *   button still needs a session to actually complete — see
 *   `isSignedIn` below; Codex review, T-1004 round 1, P1).
 * - `RELEASED`/`REFUNDED`: shows the final settlement outcome, then mounts
 *   `RatingSection` (T-1006) — this component only decides WHETHER to
 *   mount it (design.md: "RatingSection 渲染在 SettlementSection 内部...由
 *   SettlementSection 决定是否展示"); `RatingSection` decides internally
 *   whether that renders a submission form, a read-only "已评分" display,
 *   or nothing, matching this Feature's own established "later Task adds
 *   its own import" incremental convention (also `DisputeSection`, T-1005).
 *
 * A disputed task (`DISPUTED`) is `DisputeSection`'s own case (T-1005) —
 * `SettlementSection` is never rendered for it, so no "is this disputed"
 * check is needed here at all (an already-`DISPUTED` task can never reach
 * `TaskDetailSections`'s `ACCEPTED`/`SUBMITTED`/`RELEASED`/`REFUNDED` cases
 * in the first place — the status itself is the routing decision, made
 * once in `TaskDetailSections.tsx`).
 */
export function SettlementSection({ taskId }: SettlementSectionProps) {
  const session = useSession();
  const wallet = useWallet();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Codex review (T-1004 round 2, P1): `useTransactionFlow` has no
  // "definitively failed" signal from `confirm()` — ANY thrown error
  // (including a genuinely reverted receipt) lands in `rpcRecoveryPending`,
  // whose `retry()` only re-checks the SAME already-dead hash forever.
  // Since settlement has three mutually exclusive terminal transactions
  // (only one of approveResult/claimDeliveryTimeout/finalizeReviewTimeout
  // can ever actually succeed for a given task), a real revert is an
  // expected, recoverable-by-fresh-attempt outcome here, not a rare edge
  // case — this tracks which broadcast hashes were seen reverted, so the
  // retry button can route to a FRESH `start()` (new signature) instead of
  // `retry()` (re-polls the dead hash) for exactly those. Shared across all
  // three flows since tx hashes are globally unique.
  const revertedHashesRef = useRef<Set<string>>(new Set());

  function reload() {
    let ignore = false;
    setState({ status: "loading" });
    getTask(taskId)
      .then((task) => {
        if (
          task.status !== "SUBMITTED" &&
          task.status !== "RELEASED" &&
          task.status !== "REFUNDED"
        ) {
          return { task, reviewDeadline: null };
        }
        // `reviewDeadline` only exists once a deliverable has been
        // submitted (T-904/T-905's own fields) — a 404 here would be a
        // genuine anomaly for these three statuses (a submission is a
        // prerequisite to reach any of them), so it is NOT swallowed the
        // way `SubmissionSection`'s "no submission yet" 404 is; this
        // component simply falls back to an unknown deadline (disabling
        // the timeout-dependent button) rather than failing the whole load.
        return getLatestDeliverable(taskId)
          .then((deliverable) => ({ task, reviewDeadline: deliverable.reviewDeadline }))
          .catch(() => ({ task, reviewDeadline: null }));
      })
      .then((result) => {
        if (!ignore) setState({ status: "ready", ...result });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载结算信息失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }

  useEffect(reload, [taskId]);

  async function verifySettlement(txHash: `0x${string}`): Promise<VerifyOutcome> {
    try {
      const result = await submitSettlementVerification(taskId, txHash);
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

  async function confirmOnChain(txHash: `0x${string}`): Promise<{ confirmations: number }> {
    const publicClient = wallet.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      // A definitive on-chain revert (e.g. another settlement transaction
      // for this task confirmed first) — not a transient RPC failure. See
      // `revertedHashesRef`'s own comment: recorded so the retry control
      // routes to a fresh `start()` instead of endlessly re-polling this
      // now-permanently-dead hash.
      revertedHashesRef.current.add(txHash);
      throw new Error("链上交易执行失败（已回滚），请点击重试以重新发起。");
    }
    return { confirmations: 1 };
  }

  /** One `buildTx` per settlement function — all three take only `taskId`,
   * so this is the single place that difference (function name) is
   * threaded through; `confirm`/`verify` are identical across all three. */
  function buildSettlementTx(
    functionName: "approveResult" | "claimDeliveryTimeout" | "finalizeReviewTimeout",
  ): () => Promise<{ hash: `0x${string}` }> {
    return async () => {
      if (!wallet.address) throw new Error("请先连接 MetaMask 钱包。");
      const walletClient = wallet.getWalletClient();
      const hash = await walletClient.writeContract({
        address: wallet.chainConfig.addresses.taskEscrow,
        abi: TASK_ESCROW_SETTLEMENT_ABI,
        functionName,
        args: [deriveOnChainTaskId(taskId)],
        account: wallet.address,
        chain: null,
      });
      return { hash };
    };
  }

  // Three independent flows, all created unconditionally (Rules of Hooks —
  // only one is ever actually started, decided by which button the current
  // status/role combination renders below).
  const approveFlow = useTransactionFlow({
    buildTx: buildSettlementTx("approveResult"),
    confirm: confirmOnChain,
    verify: verifySettlement,
  });
  const claimTimeoutFlow = useTransactionFlow({
    buildTx: buildSettlementTx("claimDeliveryTimeout"),
    confirm: confirmOnChain,
    verify: verifySettlement,
  });
  const finalizeTimeoutFlow = useTransactionFlow({
    buildTx: buildSettlementTx("finalizeReviewTimeout"),
    confirm: confirmOnChain,
    verify: verifySettlement,
  });

  async function runFlow(flow: ReturnType<typeof useTransactionFlow>) {
    const result = await flow.start();
    if (result.outcome === "confirmed") {
      reload();
    }
  }

  async function runRetry(flow: ReturnType<typeof useTransactionFlow>) {
    // Codex review (T-1004 round 2, P1): a `rpcRecoveryPending` status
    // whose hash we already know reverted must not go through
    // `flow.retry()` (which would just re-poll that same dead hash
    // forever) — route it through `flow.start()` instead, exactly like a
    // `failed` retry does, so the user gets a fresh signature/broadcast.
    const isKnownRevertedHash =
      flow.status.kind === "rpcRecoveryPending" &&
      revertedHashesRef.current.has(flow.status.txHash);
    const result = isKnownRevertedHash ? await flow.start() : await flow.retry();
    if (result.outcome === "confirmed") {
      reload();
    }
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

  const { task, reviewDeadline } = state;
  const isRequester =
    session.status === "signed_in" &&
    !!session.address &&
    session.address.toLowerCase() === task.requesterAddress.toLowerCase();
  // Session decided WHO may see the button; the wallet CURRENTLY connected
  // decides whether they may actually sign — same two-layer check
  // `SubmissionSection.tsx`'s `walletMismatch` establishes, since the two
  // can diverge (signed in as the requester, but a different account is
  // connected in MetaMask right now).
  const walletIsRequester =
    !!wallet.address && wallet.address.toLowerCase() === task.requesterAddress.toLowerCase();
  // Codex review (T-1004 round 1, P1): `POST /tasks/:taskId/settlement-
  // verifications` requires a session (`app.requireSession`) for ALL three
  // settlement transactions — even `finalizeReviewTimeout`, whose ON-CHAIN
  // call is genuinely permissionless. A signed-out wallet could still sign
  // and broadcast the transaction, but the subsequent verification call
  // would 401 and never resolve, leaving the flow stuck in
  // `rpcRecoveryPending` with no way to ever succeed. So every settlement
  // action requires being signed in, regardless of on-chain permissions.
  const isSignedIn = session.status === "signed_in";
  // See `revertedHashesRef`'s own comment — `RetryControl` needs to know
  // whether ITS flow's current `rpcRecoveryPending` hash is a known
  // revert, to apply the same wallet/network/session gate a fresh
  // signature needs (Codex review, T-1004 round 2, P1).
  function isKnownRevertedPending(flow: ReturnType<typeof useTransactionFlow>): boolean {
    return (
      flow.status.kind === "rpcRecoveryPending" && revertedHashesRef.current.has(flow.status.txHash)
    );
  }

  return (
    <div className={SECTION_CLASSES}>
      <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">结算</h2>

      {task.status === "ACCEPTED" && (
        <AcceptedView
          task={task}
          isRequester={isRequester}
          walletIsRequester={walletIsRequester}
          isSignedIn={isSignedIn}
          wallet={wallet}
          flow={claimTimeoutFlow}
          isKnownRevertedPending={isKnownRevertedPending(claimTimeoutFlow)}
          onStart={() => void runFlow(claimTimeoutFlow)}
          onRetry={() => void runRetry(claimTimeoutFlow)}
        />
      )}

      {task.status === "SUBMITTED" && (
        <SubmittedView
          reviewDeadline={reviewDeadline}
          isRequester={isRequester}
          walletIsRequester={walletIsRequester}
          isSignedIn={isSignedIn}
          wallet={wallet}
          approveFlow={approveFlow}
          finalizeTimeoutFlow={finalizeTimeoutFlow}
          approveIsKnownRevertedPending={isKnownRevertedPending(approveFlow)}
          finalizeIsKnownRevertedPending={isKnownRevertedPending(finalizeTimeoutFlow)}
          onApprove={() => void runFlow(approveFlow)}
          onApproveRetry={() => void runRetry(approveFlow)}
          onFinalize={() => void runFlow(finalizeTimeoutFlow)}
          onFinalizeRetry={() => void runRetry(finalizeTimeoutFlow)}
        />
      )}

      {(task.status === "RELEASED" || task.status === "REFUNDED") && (
        <>
          <p className="text-body text-ink-primary">
            {task.status === "RELEASED"
              ? "任务已结算：预算与质押已支付给 Agent。"
              : "任务已结算：预算与质押已退还给需求方。"}
          </p>
          {/* T-1006: RatingSection decides internally whether to show the
              submission form, a read-only "已评分" display, or nothing —
              this component only decides WHETHER to mount it (design.md:
              "由 SettlementSection 决定是否展示"), matching the same
              shallow-parent/deep-child split DisputeSection already uses. */}
          <RatingSection taskId={taskId} isRequester={isRequester} />
        </>
      )}
    </div>
  );
}

/**
 * The retry control shared by all three settlement buttons (Codex review,
 * T-1004 round 1, P1): without this, a `failed` (e.g. wallet rejected the
 * signature) or `rpcRecoveryPending` (e.g. the confirm/verify step hit a
 * transient error after a REAL broadcast) status left the button
 * permanently disabled — there was no way to ever recover, even though
 * `useTransactionFlow.retry()` exists exactly for this. Mirrors
 * `SubmissionSection.tsx`'s own `submitRecoverable`/`handleRetrySubmit`
 * distinction: a `failed` retry re-broadcasts (needs the SAME
 * wallet/network/session gate a fresh `start()` needs), a
 * `rpcRecoveryPending` retry normally only re-checks an already-broadcast
 * transaction (no new signature) — EXCEPT when that hash is a known
 * on-chain revert (`isKnownRevertedPending`, Codex review T-1004 round 2
 * P1), in which case `SettlementSection`'s own `runRetry` routes it
 * through a fresh `start()` too, so this button must apply the SAME gate
 * in that case as well.
 */
function RetryControl({
  flow,
  blockedForNewSignature,
  isKnownRevertedPending,
  onRetry,
}: {
  flow: ReturnType<typeof useTransactionFlow>;
  blockedForNewSignature: boolean;
  isKnownRevertedPending: boolean;
  onRetry: () => void;
}) {
  const recoverable = flow.status.kind === "rpcRecoveryPending" || flow.status.kind === "failed";
  if (!recoverable) return null;
  const retryNeedsFreshSignature = flow.status.kind === "failed" || isKnownRevertedPending;
  const retryBlocked = retryNeedsFreshSignature && blockedForNewSignature;
  return (
    <button
      type="button"
      disabled={retryBlocked}
      onClick={onRetry}
      className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
    >
      重试
    </button>
  );
}

interface AcceptedViewProps {
  task: TaskRecord;
  isRequester: boolean;
  walletIsRequester: boolean;
  isSignedIn: boolean;
  wallet: ReturnType<typeof useWallet>;
  flow: ReturnType<typeof useTransactionFlow>;
  isKnownRevertedPending: boolean;
  onStart: () => void;
  onRetry: () => void;
}

function AcceptedView({
  task,
  isRequester,
  walletIsRequester,
  isSignedIn,
  wallet,
  flow,
  isKnownRevertedPending,
  onStart,
  onRetry,
}: AcceptedViewProps) {
  const deadlinePassed = isPast(task.deliveryDeadline);
  const blockedForNewSignature = !isSignedIn || !walletIsRequester || !wallet.isCorrectNetwork;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-ink-secondary">
        交付截止时间：
        <span className="text-ink-primary">{formatTimestamp(task.deliveryDeadline)}</span>
      </p>
      {!isRequester && <p className="text-caption text-ink-secondary">等待 Agent 交付成果。</p>}
      {isRequester && !deadlinePassed && (
        <p className="text-caption text-ink-secondary">尚未到交付截止时间，暂不可申领超时退款。</p>
      )}
      {isRequester && deadlinePassed && flow.status.kind !== "confirmed" && (
        <>
          <div className="flex items-center justify-between text-caption">
            <span className="font-medium text-ink-primary">
              申领交付逾期退款（claimDeliveryTimeout）
            </span>
            <TransactionStatusView status={flow.status} />
          </div>
          {!isSignedIn && (
            <p role="alert" className="text-caption text-warning">
              请先登录后再发起交易（结算结果需要登录后才能提交后端复核）。
            </p>
          )}
          {!wallet.isCorrectNetwork && (
            <p role="alert" className="text-caption text-warning">
              当前网络不正确，请先切换到 {wallet.chainConfig.name} 后再发起交易。
            </p>
          )}
          {!walletIsRequester && (
            <p role="alert" className="text-caption text-warning">
              当前连接的钱包地址与需求方不匹配，请在 MetaMask 中切换到正确的账户后重试。
            </p>
          )}
          <button
            type="button"
            disabled={blockedForNewSignature || flow.status.kind !== "idle"}
            onClick={onStart}
            className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取回预算和质押
          </button>
          <RetryControl
            flow={flow}
            blockedForNewSignature={blockedForNewSignature}
            isKnownRevertedPending={isKnownRevertedPending}
            onRetry={onRetry}
          />
        </>
      )}
      {flow.status.kind === "confirmed" && (
        <p className="text-caption text-success">已成功取回预算和质押。</p>
      )}
    </div>
  );
}

interface SubmittedViewProps {
  reviewDeadline: string | null;
  isRequester: boolean;
  walletIsRequester: boolean;
  isSignedIn: boolean;
  wallet: ReturnType<typeof useWallet>;
  approveFlow: ReturnType<typeof useTransactionFlow>;
  finalizeTimeoutFlow: ReturnType<typeof useTransactionFlow>;
  approveIsKnownRevertedPending: boolean;
  finalizeIsKnownRevertedPending: boolean;
  onApprove: () => void;
  onApproveRetry: () => void;
  onFinalize: () => void;
  onFinalizeRetry: () => void;
}

function SubmittedView({
  reviewDeadline,
  isRequester,
  walletIsRequester,
  isSignedIn,
  wallet,
  approveFlow,
  finalizeTimeoutFlow,
  approveIsKnownRevertedPending,
  finalizeIsKnownRevertedPending,
  onApprove,
  onApproveRetry,
  onFinalize,
  onFinalizeRetry,
}: SubmittedViewProps) {
  const deadlinePassed = isPast(reviewDeadline);
  const settled =
    approveFlow.status.kind === "confirmed" || finalizeTimeoutFlow.status.kind === "confirmed";

  if (settled) {
    return <p className="text-caption text-success">验收已完成，任务已结算。</p>;
  }

  // Codex review (T-1004 round 2, P2; refined round 3, P2): `approveResult`
  // and `finalizeReviewTimeout` are mutually exclusive terminal
  // transactions for the SAME task — once one confirms on-chain, the
  // other necessarily reverts. Both buttons are shown together once the
  // review deadline has passed, so each is also disabled while the OTHER
  // flow could still succeed (`flowBlocksOtherSettlementAction`, defined
  // once above — never a plain `!== "idle"` check, which incorrectly also
  // blocked on a `failed` or known-reverted attempt that can never
  // succeed).
  const approveBlockedForNewSignature =
    !isSignedIn ||
    !walletIsRequester ||
    !wallet.isCorrectNetwork ||
    flowBlocksOtherSettlementAction(finalizeTimeoutFlow, finalizeIsKnownRevertedPending);
  // Codex review (T-1004 round 1, P1): finalizeReviewTimeout is
  // permissionless ON-CHAIN, but `verifySettlement` still requires a
  // session — so `isSignedIn` (not `walletIsRequester`) gates this one.
  const finalizeBlockedForNewSignature =
    !isSignedIn ||
    !wallet.address ||
    !wallet.isCorrectNetwork ||
    flowBlocksOtherSettlementAction(approveFlow, approveIsKnownRevertedPending);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-caption text-ink-secondary">
        验收截止时间：<span className="text-ink-primary">{formatTimestamp(reviewDeadline)}</span>
      </p>

      {isRequester && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-caption">
            <span className="font-medium text-ink-primary">验收通过（approveResult）</span>
            <TransactionStatusView status={approveFlow.status} />
          </div>
          {!isSignedIn && (
            <p role="alert" className="text-caption text-warning">
              请先登录后再发起交易（结算结果需要登录后才能提交后端复核）。
            </p>
          )}
          {!walletIsRequester && (
            <p role="alert" className="text-caption text-warning">
              当前连接的钱包地址与需求方不匹配，请在 MetaMask 中切换到正确的账户后重试。
            </p>
          )}
          <button
            type="button"
            disabled={approveBlockedForNewSignature || approveFlow.status.kind !== "idle"}
            onClick={onApprove}
            className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            验收并放款
          </button>
          <RetryControl
            flow={approveFlow}
            blockedForNewSignature={approveBlockedForNewSignature}
            isKnownRevertedPending={approveIsKnownRevertedPending}
            onRetry={onApproveRetry}
          />
        </div>
      )}

      {!isRequester && !deadlinePassed && (
        <p className="text-caption text-ink-secondary">等待需求方验收，或等待验收窗口到期。</p>
      )}

      {deadlinePassed && (
        // Permissionless ON-CHAIN (F-1002/F-108): not gated on
        // `isRequester`/`walletIsRequester` — any connected wallet may
        // trigger this once the review window has passed. Still gated on
        // `isSignedIn` (see `finalizeBlockedForNewSignature`'s own comment
        // above) — the backend verification call is not permissionless.
        <div className="flex flex-col gap-2 border-t border-divider-light pt-4">
          <div className="flex items-center justify-between text-caption">
            <span className="font-medium text-ink-primary">
              验收已超时，任意地址可放款给 Agent（finalizeReviewTimeout）
            </span>
            <TransactionStatusView status={finalizeTimeoutFlow.status} />
          </div>
          {!isSignedIn && (
            <p role="alert" className="text-caption text-warning">
              请先登录后再发起交易（链上调用本身无需身份限制，但结果复核需要登录后才能提交）。
            </p>
          )}
          {!wallet.isCorrectNetwork && (
            <p role="alert" className="text-caption text-warning">
              当前网络不正确，请先切换到 {wallet.chainConfig.name} 后再发起交易。
            </p>
          )}
          <button
            type="button"
            disabled={finalizeBlockedForNewSignature || finalizeTimeoutFlow.status.kind !== "idle"}
            onClick={onFinalize}
            className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
          >
            放款给 Agent
          </button>
          <RetryControl
            flow={finalizeTimeoutFlow}
            blockedForNewSignature={finalizeBlockedForNewSignature}
            isKnownRevertedPending={finalizeIsKnownRevertedPending}
            onRetry={onFinalizeRetry}
          />
        </div>
      )}
    </div>
  );
}
