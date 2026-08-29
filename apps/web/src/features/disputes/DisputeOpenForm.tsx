import { useRef, useState } from "react";
import { keccak256, toBytes } from "viem";
import { useWallet } from "../wallet/WalletProvider.js";
import {
  ApiError,
  submitDispute,
  submitDisputeOpenVerification,
  type DisputeSubmissionResult,
} from "./api.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow, type VerifyOutcome } from "../../shared/tx-flow/useTransactionFlow.js";
import { TASK_ESCROW_OPEN_DISPUTE_ABI } from "./abi.js";

export interface DisputeOpenFormProps {
  taskId: string;
  /** Called once the on-chain `openDispute` transaction is confirmed AND
   * backend-verified — `DisputeSection` closes the `ActionSheet` and
   * reloads its own dispute state. */
  onOpened: () => void;
  /**
   * T-1005 follow-up (Codex review, T-1007 round 1, P1 — routed to this
   * Task's own lineage): a dispute this task ALREADY has saved off-chain
   * (`DisputeSection`'s own `GET /tasks/:taskId/disputes` fetch found an
   * OPEN dispute while the task is still SUBMITTED) — the user saved
   * evidence but never got to sign+broadcast `openDispute` (closed the
   * tab, lost the wallet connection, refreshed). Passed in as INITIAL
   * state (Option A over building a separate "resume" component, per the
   * user's own comparison: reuses this exact same sign/broadcast/verify
   * flow and interface instead of duplicating `openDispute`'s state
   * machine and recovery rules in a second component) — when present,
   * this component starts directly in the `submitted` view (evidence
   * hash shown, ready to sign) instead of the blank form, and
   * `handleSubmit`/`submitDispute` is never reachable from that state:
   * the form fields aren't even rendered once `submitState.status ===
   * "submitted"` (see the render branch below), so resuming can never
   * re-POST a second dispute for this task.
   */
  existingDispute?: DisputeSubmissionResult;
}

/** Same derivation `SubmissionSection.tsx`/`SettlementSection.tsx` mirror
 * from `apps/api`'s `onchain-task-id.ts`. */
function deriveOnChainTaskId(taskId: string): `0x${string}` {
  return keccak256(toBytes(taskId));
}

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "submitted"; result: DisputeSubmissionResult }
  | { status: "error"; message: string };

/**
 * T-1005: the `ActionSheet` content for "发起争议" (F-1003) — same
 * two-step "persist off-chain artifact, then sign the on-chain call
 * referencing it" shape `SubmissionSection.tsx`'s upload/hash/submit flow
 * establishes: `reason`/`evidenceSummary` are POSTed to
 * `POST /tasks/:taskId/disputes` FIRST (the backend computes and returns
 * `evidenceHash`), and only THAT returned hash is what `openDispute`
 * actually signs — never a hash recomputed here.
 */
export function DisputeOpenForm({ taskId, onOpened, existingDispute }: DisputeOpenFormProps) {
  const wallet = useWallet();
  const [reason, setReason] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>(() =>
    existingDispute ? { status: "submitted", result: existingDispute } : { status: "idle" },
  );
  // Same request-sequence guard `SubmissionSection.tsx` uses (N4 round 1
  // P2 there): editing the form fields while a submit is in flight must
  // not let a now-abandoned response resurrect a stale `submitted` state.
  const submitRequestSeqRef = useRef(0);

  async function handleSubmit() {
    const requestSeq = ++submitRequestSeqRef.current;
    const isStale = () => submitRequestSeqRef.current !== requestSeq;
    setSubmitState({ status: "submitting" });
    try {
      const result = await submitDispute(taskId, { reason, evidenceSummary });
      if (isStale()) return;
      setSubmitState({ status: "submitted", result });
    } catch (error) {
      if (isStale()) return;
      setSubmitState({
        status: "error",
        message: error instanceof ApiError ? error.message : "保存争议信息失败，请重试。",
      });
    }
  }

  async function buildOpenDisputeTx(): Promise<{ hash: `0x${string}` }> {
    if (submitState.status !== "submitted") {
      throw new Error("请先完成争议信息保存，获取即将上链的证据哈希。");
    }
    if (!wallet.address) throw new Error("请先连接 MetaMask 钱包。");
    const walletClient = wallet.getWalletClient();
    const hash = await walletClient.writeContract({
      address: wallet.chainConfig.addresses.taskEscrow,
      abi: TASK_ESCROW_OPEN_DISPUTE_ABI,
      functionName: "openDispute",
      args: [deriveOnChainTaskId(taskId), submitState.result.evidenceHash],
      account: wallet.address,
      chain: null,
    });
    return { hash };
  }

  async function confirmOnChain(txHash: `0x${string}`): Promise<{ confirmations: number }> {
    const publicClient = wallet.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error("链上交易执行失败（已回滚），请点击重试以重新发起。");
    }
    return { confirmations: 1 };
  }

  async function verifyOpenDispute(txHash: `0x${string}`): Promise<VerifyOutcome> {
    try {
      const result = await submitDisputeOpenVerification(taskId, txHash);
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

  const openFlow = useTransactionFlow({
    buildTx: buildOpenDisputeTx,
    confirm: confirmOnChain,
    verify: verifyOpenDispute,
  });

  async function handleStartOpen() {
    const result = await openFlow.start();
    if (result.outcome === "confirmed") {
      onOpened();
    }
  }

  async function handleRetryOpen() {
    if (openFlow.status.kind === "failed" && !wallet.isCorrectNetwork) return;
    const result = await openFlow.retry();
    if (result.outcome === "confirmed") {
      onOpened();
    }
  }

  const openRecoverable =
    openFlow.status.kind === "rpcRecoveryPending" || openFlow.status.kind === "failed";

  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="text-[20px] font-semibold text-ink-primary">发起争议</h2>

      {submitState.status !== "submitted" ? (
        <>
          <label className="flex flex-col gap-1 text-caption text-ink-primary">
            争议原因
            <input
              type="text"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="rounded-control border border-divider-light px-3 py-2 text-caption text-ink-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-caption text-ink-primary">
            证据说明
            <textarea
              value={evidenceSummary}
              maxLength={10_000}
              rows={5}
              onChange={(event) => setEvidenceSummary(event.target.value)}
              className="rounded-control border border-divider-light px-3 py-2 text-caption text-ink-primary"
            />
          </label>
          {submitState.status === "error" && (
            <p role="alert" className="text-caption text-warning">
              {submitState.message}
            </p>
          )}
          <button
            type="button"
            disabled={
              submitState.status === "submitting" || !reason.trim() || !evidenceSummary.trim()
            }
            onClick={() => void handleSubmit()}
            className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitState.status === "submitting" ? "保存中…" : "保存争议信息"}
          </button>
        </>
      ) : (
        <>
          {/* F-1003: the exact value about to be signed — read straight from
              the backend's own response, never recomputed here. Once saved,
              this is treated as an immutable submission — NOT an editable
              draft (Codex review, T-1005 follow-up P2, human-reviewed): the
              first POST's returned `evidenceHash` may already be broadcast
              (another tab, a wallet extension's own queue) by the time a
              second save attempt could run, and `POST /tasks/:taskId/disputes`
              itself is one-shot (`disputes_task_id_unique_open` rejects a
              second submission for the same task with 409) — there was never
              a working "edit and resave" path, only a dead-end "重新填写"
              button that always failed. No "重新填写"/reset control exists
              here on purpose; the fields above are only ever editable BEFORE
              the first successful save. */}
          <p className="text-caption text-ink-secondary">
            即将上链的证据哈希：
            <span className="break-all text-ink-primary">{submitState.result.evidenceHash}</span>
          </p>
          <p className="text-caption text-ink-secondary">
            争议信息已保存，证据内容不可修改，请核对后提交上链。
          </p>

          {/* design.md's dispute reference (docs/stitch_agent_market_landing_page 2's
              settlement_operation_modals_set "发起争议" card) — real
              consequence copy for opening a dispute, not a fabricated
              warning: `resolveDispute` (contracts/src/TaskEscrow.sol) is
              exactly the "平台治理节点介入" this describes, and disputes are
              the only settlement path with no automatic timeout release. */}
          <p className="rounded-input border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
            发起争议将引入平台仲裁介入；争议解决前，正常的验收超时自动放款将暂停。
          </p>

          <div className="flex items-center justify-between text-caption">
            <span className="font-medium text-ink-primary">提交争议上链（openDispute）</span>
            <TransactionStatusView status={openFlow.status} />
          </div>
          {!wallet.isCorrectNetwork && (
            <p role="alert" className="text-caption text-warning">
              当前网络不正确，请先切换到 {wallet.chainConfig.name} 后再发起交易。
            </p>
          )}
          {openFlow.status.kind === "confirmed" ? (
            <p className="text-caption text-success">争议已成功提交上链。</p>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!wallet.isCorrectNetwork || openFlow.status.kind !== "idle"}
                onClick={() => void handleStartOpen()}
                className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                提交争议
              </button>
              {openRecoverable && (
                <button
                  type="button"
                  disabled={openFlow.status.kind === "failed" && !wallet.isCorrectNetwork}
                  onClick={() => void handleRetryOpen()}
                  className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  重试
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
