import { useEffect, useRef, useState } from "react";
import { keccak256, toBytes } from "viem";
import { useSession } from "../session/SessionProvider.js";
import { useWallet } from "../wallet/WalletProvider.js";
import { ApiError, getTask, type TaskRecord } from "../tasks/api.js";
import { apiBaseUrl } from "../../shared/api/client.js";
import { Uploader } from "../../shared/components/Uploader.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow, type VerifyOutcome } from "../../shared/tx-flow/useTransactionFlow.js";
import { TASK_ESCROW_SUBMIT_RESULT_ABI } from "./abi.js";
import {
  ApiError as DeliverablesApiError,
  getLatestDeliverable,
  submitDeliverableUrl,
  submitResultVerification,
  uploadDeliverableFile,
  type DeliverableLatest,
  type DeliverableSubmissionResult,
} from "./api.js";

export interface SubmissionSectionProps {
  taskId: string;
  /** Notifies the task-detail owner to reload its authoritative status. */
  onSubmitted?: () => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; task: TaskRecord; deliverable: DeliverableLatest | null }
  | { status: "error"; message: string };

/** Which input mode the Agent is currently using — mutually exclusive,
 * matching `deliverables_payload_matches_storage_type`'s own DB-level
 * "exactly one of file or URL" invariant (0009_create_deliverables.sql). */
type InputMode = "file" | "url";

type PersistState =
  | { status: "idle" }
  | { status: "persisting" }
  | { status: "persisted"; result: DeliverableSubmissionResult }
  | { status: "error"; message: string };

const SECTION_CLASSES = "mt-8 rounded-card border border-divider-light bg-surface-light p-6 md:p-8";

/** Same derivation `AcceptConfirmContent.tsx` mirrors from
 * `apps/api`'s `onchain-task-id.ts` — a pure, permanently-stable function
 * of the UUID, recomputed here rather than added to any response
 * contract. */
function deriveOnChainTaskId(taskId: string): `0x${string}` {
  return keccak256(toBytes(taskId));
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * T-908: accepts `Feature 6 TaskDetailSections.tsx`'s `ACCEPTED`/`SUBMITTED`
 * cases via a one-line import + case (AC-907) — fetches its own
 * `TaskRecord`/`DeliverableLatest`, same "each section fetches its own
 * data" convention `FundingSection`/`AcceptanceSection` already establish,
 * rather than `TaskDetailSections` growing a shared props shape.
 *
 * Renders one of two views depending on who's looking (session address is
 * the identity source, never `wallet.address` — same lesson
 * `FundingSection` already documents):
 *   - the accepted Agent, while the task is still `ACCEPTED`: the
 *     upload/URL → hash preview → `submitResult` flow below.
 *   - everyone else (the requester, a signed-out visitor, or the Agent
 *     once the task has reached `SUBMITTED`): a read-only display of the
 *     latest deliverable's metadata (F-902) — never a duplicate of the
 *     submission form.
 */
export function SubmissionSection({ taskId, onSubmitted }: SubmissionSectionProps) {
  const session = useSession();
  const wallet = useWallet();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const [inputMode, setInputMode] = useState<InputMode>("file");
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [resultUrl, setResultUrl] = useState("");
  const [persistState, setPersistState] = useState<PersistState>({ status: "idle" });
  // N4 round 1 P2 (Codex): a request-sequence guard against the mode-switch
  // race — switching input mode (or picking a new file / retyping the URL)
  // while a `handlePersist` call is still in flight must NOT let that
  // now-abandoned response land as `persisted` once it resolves. Every
  // state-invalidating action below goes through `resetPersistState`, which
  // bumps this counter FIRST; `handlePersist` captures its own value at
  // call time and only applies its result if the counter still matches
  // when the request resolves — a stale response silently no-ops instead
  // of resurrecting output for input the user already abandoned.
  const persistRequestSeqRef = useRef(0);

  function resetPersistState() {
    persistRequestSeqRef.current += 1;
    setPersistState({ status: "idle" });
  }

  function reload() {
    let ignore = false;
    setState({ status: "loading" });
    getTask(taskId)
      .then((task) =>
        getLatestDeliverable(taskId)
          .then((deliverable) => ({ task, deliverable }))
          .catch((error: unknown) => {
            // A 404 ("尚无成果提交记录") is the routine "not submitted yet"
            // case, not a load failure — every other error still fails
            // this whole load, since the task's own accompanying data
            // (title/status) is meaningless to show without knowing
            // whether the deliverable fetch itself is trustworthy.
            if (error instanceof DeliverablesApiError && error.status === 404) {
              return { task, deliverable: null };
            }
            throw error;
          }),
      )
      .then((result) => {
        if (!ignore) setState({ status: "ready", ...result });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载成果提交信息失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }

  useEffect(reload, [taskId]);

  async function handlePersist() {
    const requestSeq = ++persistRequestSeqRef.current;
    const isStale = () => persistRequestSeqRef.current !== requestSeq;
    setPersistState({ status: "persisting" });
    try {
      const result =
        inputMode === "file"
          ? selectedFile && (await uploadDeliverableFile(taskId, selectedFile))
          : resultUrl && (await submitDeliverableUrl(taskId, resultUrl));
      if (isStale()) return;
      if (!result) {
        setPersistState({
          status: "error",
          message: inputMode === "file" ? "请先选择要上传的文件。" : "请先填写成果 URL。",
        });
        return;
      }
      setPersistState({ status: "persisted", result });
    } catch (error) {
      if (isStale()) return;
      setPersistState({
        status: "error",
        message: error instanceof ApiError ? error.message : "保存成果失败，请重试。",
      });
    }
  }

  async function buildSubmitResultTx(): Promise<{ hash: `0x${string}` }> {
    if (persistState.status !== "persisted") {
      throw new Error("请先完成成果保存，获取即将上链的哈希。");
    }
    if (!wallet.address) throw new Error("请先连接 MetaMask 钱包。");
    const walletClient = wallet.getWalletClient();
    const hash = await walletClient.writeContract({
      address: wallet.chainConfig.addresses.taskEscrow,
      abi: TASK_ESCROW_SUBMIT_RESULT_ABI,
      functionName: "submitResult",
      args: [deriveOnChainTaskId(taskId), persistState.result.resultHash],
      account: wallet.address,
      chain: null,
    });
    return { hash };
  }

  async function confirmSubmitResultOnChain(
    txHash: `0x${string}`,
  ): Promise<{ confirmations: number }> {
    const publicClient = wallet.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error("链上交易执行失败（已回滚）。");
    }
    return { confirmations: 1 };
  }

  async function verifySubmitResult(txHash: `0x${string}`): Promise<VerifyOutcome> {
    try {
      const result = await submitResultVerification(taskId, txHash);
      if ("status" in result) {
        return { outcome: "confirmed" };
      }
      return { outcome: "rpcUnavailable", error: result.error.message };
    } catch (error) {
      if (error instanceof DeliverablesApiError && error.code) {
        return { outcome: "rejected", errorCode: error.code };
      }
      throw error;
    }
  }

  const submitFlow = useTransactionFlow({
    buildTx: buildSubmitResultTx,
    confirm: confirmSubmitResultOnChain,
    verify: verifySubmitResult,
  });

  async function handleStartSubmit() {
    const result = await submitFlow.start();
    if (result.outcome === "confirmed") {
      reload();
      onSubmitted?.();
    }
  }

  // N4 round 2 P1 (Codex): only a `failed`-status retry re-broadcasts (it
  // re-runs `buildSubmitResultTx`, signing and submitting a NEW
  // transaction) — that must go through the exact same wallet/network gate
  // `handleStartSubmit`'s own button already enforces, since the wallet
  // account or network could have changed since the first attempt failed.
  // `rpcRecoveryPending` is exempt: it only re-checks an ALREADY-broadcast
  // transaction's receipt/backend verification, no new signature involved,
  // so there is nothing a wallet/network switch could misdirect.
  async function handleRetrySubmit() {
    if (submitFlow.status.kind === "failed" && (walletMismatch || !wallet.isCorrectNetwork)) {
      return;
    }
    const result = await submitFlow.retry();
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

  const { task, deliverable } = state;
  const isAcceptedAgent =
    session.status === "signed_in" &&
    !!session.address &&
    !!task.acceptedAgentAddress &&
    session.address.toLowerCase() === task.acceptedAgentAddress.toLowerCase();
  const canSubmit = isAcceptedAgent && task.status === "ACCEPTED";
  // Display-only mirror of `access-guard.ts`'s `isAuthorizedForDeliverableAccess`
  // (F-908) — the backend re-checks this itself on every request to
  // `GET .../latest/file` regardless of what this renders, so getting this
  // wrong here is a UX gap, never a security gap. Used only to decide
  // whether to show the download link at all (AC-905: "需求方...能通过受权
  // 限保护的下载接口获取文件内容").
  const isRequester =
    session.status === "signed_in" &&
    !!session.address &&
    session.address.toLowerCase() === task.requesterAddress.toLowerCase();

  if (!canSubmit) {
    return (
      <div className={SECTION_CLASSES}>
        <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">成果提交</h2>
        {deliverable ? (
          <>
            <dl className="grid grid-cols-1 gap-3 text-caption sm:grid-cols-2">
              <div>
                <dt className="text-ink-secondary">成果哈希</dt>
                <dd className="break-all text-ink-primary">{deliverable.resultHash}</dd>
              </div>
              {deliverable.resultUrl && (
                <div>
                  <dt className="text-ink-secondary">成果地址</dt>
                  <dd className="break-all text-ink-primary">{deliverable.resultUrl}</dd>
                </div>
              )}
              {deliverable.fileMeta && (
                <div>
                  <dt className="text-ink-secondary">文件信息</dt>
                  <dd className="text-ink-primary">
                    {deliverable.fileMeta.mimeType ?? "未知类型"}
                    {deliverable.fileMeta.sizeBytes != null
                      ? `（${deliverable.fileMeta.sizeBytes} 字节）`
                      : ""}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-ink-secondary">提交时间</dt>
                <dd className="text-ink-primary">{formatTimestamp(deliverable.submittedAt)}</dd>
              </div>
              <div>
                <dt className="text-ink-secondary">验收截止</dt>
                <dd className="text-ink-primary">{formatTimestamp(deliverable.reviewDeadline)}</dd>
              </div>
            </dl>
            {(isRequester || isAcceptedAgent) && (
              // AC-905: a real link to F-908's protected download route —
              // a plain top-level `<a>` navigation, not `apiFetch` (that's
              // built for JSON responses, not a file stream/302 redirect).
              // The session cookie is `sameSite: "lax"` (auth/routes.ts),
              // so it's sent on this navigation without any extra wiring;
              // the backend re-enforces F-908 itself regardless of who
              // this link is shown to.
              <a
                href={`${apiBaseUrl()}/tasks/${taskId}/deliverables/latest/file`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-block text-caption font-medium text-action-blue underline"
              >
                下载成果文件
              </a>
            )}
          </>
        ) : (
          <p className="text-body text-ink-secondary">该任务尚无成果提交记录。</p>
        )}
      </div>
    );
  }

  // Re-derived every render from the current wallet, not cached — the same
  // "session decided eligibility, but signing uses whatever wallet is
  // CURRENTLY connected" gap `AcceptConfirmContent.tsx` documents and
  // guards against identically.
  const walletMismatch =
    !wallet.address || wallet.address.toLowerCase() !== task.acceptedAgentAddress?.toLowerCase();
  const submitRecoverable =
    submitFlow.status.kind === "rpcRecoveryPending" || submitFlow.status.kind === "failed";
  const submitDone = submitFlow.status.kind === "confirmed";
  // N4 round 2 P1 (Codex): a `failed` retry re-broadcasts under whatever
  // wallet/network is CURRENTLY connected — block it (both the click
  // handler above and this disabled state) exactly like a first attempt,
  // unless the flow is only recovering an already-broadcast tx
  // (`rpcRecoveryPending`, no new signature).
  const retryBlockedByWalletGate =
    submitFlow.status.kind === "failed" && (walletMismatch || !wallet.isCorrectNetwork);
  // N4 round 2 P2 (Codex) + round 3 human follow-up (the round-2 fix only
  // gated the "重新选择" BUTTON, leaving the two input-mode radios — which
  // call the exact same `resetPersistState` — as a live bypass): NO entry
  // point that can invalidate `persistState` may run while a transaction
  // is actually in flight. `failed` is deliberately NOT included — that
  // status has broadcast NOTHING yet (the signature/broadcast itself
  // failed), so choosing a different result to submit instead is safe;
  // only `rpcRecoveryPending` (an ALREADY-broadcast tx whose confirmation
  // failed) has a live transaction whose only recovery path
  // (`retry()`/"重试提交") a reset would hide.
  const submitInFlight =
    submitFlow.status.kind === "awaitingSignature" ||
    submitFlow.status.kind === "pending" ||
    submitFlow.status.kind === "confirming" ||
    submitFlow.status.kind === "verifying" ||
    submitFlow.status.kind === "rpcRecoveryPending";
  // The ONE derived rule for "may the user reset their staged submission
  // right now" — used for every `disabled` prop below AND inside every
  // handler that would otherwise call `resetPersistState` directly, so a
  // future new entry point (another button, another input) is gated by
  // construction rather than by remembering to copy this check to it.
  const canResetPersistedResult = !submitInFlight;

  function guardedResetPersistState() {
    if (!canResetPersistedResult) return;
    resetPersistState();
  }

  return (
    <div className={SECTION_CLASSES}>
      <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">成果提交</h2>

      {submitDone ? (
        <p className="text-caption text-success">成果已提交上链。</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div role="radiogroup" aria-label="选择成果提交方式" className="flex gap-4 text-caption">
            <label className="flex items-center gap-2 text-ink-primary">
              <input
                type="radio"
                name="submission-input-mode"
                checked={inputMode === "file"}
                // Deliberately NOT gated on `persistState.status ===
                // "persisting"` — round 1's sequence-guard (`handlePersist`'s
                // `isStale()` check) exists specifically to make switching
                // mode WHILE a save request is in flight safe; only a live
                // on-chain transaction (`submitInFlight`) blocks this.
                disabled={submitInFlight}
                onChange={() => {
                  if (!canResetPersistedResult) return;
                  setInputMode("file");
                  guardedResetPersistState();
                }}
              />
              上传文件
            </label>
            <label className="flex items-center gap-2 text-ink-primary">
              <input
                type="radio"
                name="submission-input-mode"
                checked={inputMode === "url"}
                disabled={submitInFlight}
                onChange={() => {
                  if (!canResetPersistedResult) return;
                  setInputMode("url");
                  guardedResetPersistState();
                }}
              />
              填写成果 URL
            </label>
          </div>

          {inputMode === "file" ? (
            <Uploader
              onFileSelected={(file) => {
                setSelectedFile(file);
                guardedResetPersistState();
              }}
              disabled={persistState.status === "persisting" || submitInFlight}
            />
          ) : (
            <input
              type="url"
              placeholder="https://..."
              value={resultUrl}
              onChange={(event) => {
                setResultUrl(event.target.value);
                guardedResetPersistState();
              }}
              disabled={persistState.status === "persisting" || submitInFlight}
              className="rounded-control border border-divider-light px-3 py-2 text-caption text-ink-primary"
            />
          )}

          {persistState.status !== "persisted" && (
            <button
              type="button"
              disabled={
                persistState.status === "persisting" ||
                (inputMode === "file" ? !selectedFile : !resultUrl)
              }
              onClick={() => void handlePersist()}
              className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {persistState.status === "persisting" ? "保存中…" : "计算成果哈希"}
            </button>
          )}

          {persistState.status === "error" && (
            <p role="alert" className="text-caption text-warning">
              {persistState.message}
            </p>
          )}

          {persistState.status === "persisted" && (
            <>
              {/* F-903: the exact value about to be signed — read straight
                  from the backend's own response, never recomputed here. */}
              <p className="text-caption text-ink-secondary">
                即将上链的成果哈希：
                <span className="break-all text-ink-primary">{persistState.result.resultHash}</span>
              </p>
              <button
                type="button"
                disabled={!canResetPersistedResult}
                onClick={guardedResetPersistState}
                className="self-start text-caption text-action-blue underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                重新选择
              </button>

              <div className="flex items-center justify-between text-caption">
                <span className="font-medium text-ink-primary">提交上链（submitResult）</span>
                <TransactionStatusView status={submitFlow.status} />
              </div>
              {submitRecoverable && (
                <button
                  type="button"
                  disabled={retryBlockedByWalletGate}
                  onClick={() => void handleRetrySubmit()}
                  className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  重试提交
                </button>
              )}

              {!wallet.isCorrectNetwork && (
                <p role="alert" className="text-caption text-warning">
                  当前网络不正确，请先切换到 {wallet.chainConfig.name} 后再发起交易。
                </p>
              )}
              {walletMismatch && (
                <p role="alert" className="text-caption text-warning">
                  当前连接的钱包地址与接单 Agent 不匹配，请在 MetaMask 中切换到正确的账户后重试。
                </p>
              )}

              {/* design.md's Task Workspace reference ("提交前检查清单") — every
                  row here is a REAL derived condition already computed above
                  (never a fabricated/decorative checklist item), so it can
                  never disagree with the actual disabled state of the
                  "提交成果" button just below it. */}
              <ul className="flex flex-col gap-1.5 rounded-input bg-canvas-warm p-4 text-caption">
                <li className="flex items-center gap-2">
                  <span aria-hidden="true">
                    {persistState.status === "persisted" ? "✅" : "⬜"}
                  </span>
                  <span className="text-ink-primary">已计算成果哈希</span>
                </li>
                <li className="flex items-center gap-2">
                  <span aria-hidden="true">{wallet.isCorrectNetwork ? "✅" : "⬜"}</span>
                  <span className="text-ink-primary">
                    已连接正确网络（{wallet.chainConfig.name}）
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span aria-hidden="true">{!walletMismatch ? "✅" : "⬜"}</span>
                  <span className="text-ink-primary">当前钱包地址与接单 Agent 一致</span>
                </li>
              </ul>

              <button
                type="button"
                disabled={
                  walletMismatch || !wallet.isCorrectNetwork || submitFlow.status.kind !== "idle"
                }
                onClick={() => void handleStartSubmit()}
                className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                提交成果
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
