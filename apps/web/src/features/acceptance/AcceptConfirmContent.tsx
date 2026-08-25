import { useEffect, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, keccak256, toBytes } from "viem";
import { formatAmount, isErrorCode } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow, type VerifyOutcome } from "../../shared/tx-flow/useTransactionFlow.js";
import { ERC20_APPROVE_ABI, TASK_ESCROW_ACCEPT_TASK_ABI } from "../tasks/abi.js";
import { getTask } from "../tasks/api.js";
import {
  ApiError,
  getMyAcceptancePermit,
  submitAcceptanceVerification,
  type AcceptancePermitRecord,
} from "./api.js";

/**
 * T-804: the fixed message both failure paths below use to mark "acceptTask
 * failed because a different candidate accepted first" — `useTransactionFlow`
 * only carries failures forward as a plain `string` (`status.reason` /
 * `status.lastError`, both produced by `errorMessage(error)` in that Hook),
 * so an exact match against this constant (not a fuzzy string search) is how
 * the render logic below tells this one specific, recognized failure apart
 * from any other message a wallet/RPC/contract could produce.
 */
const TASK_ALREADY_ACCEPTED_MESSAGE =
  "该任务已被接单：已有其他候选先完成了接单，请刷新页面查看任务当前状态。";

function isTaskAlreadyAcceptedReason(reason: string): boolean {
  return reason === TASK_ALREADY_ACCEPTED_MESSAGE;
}

/** `TaskEscrow.TaskStatus`'s on-chain enum ordering
 * (contracts/src/TaskEscrow.sol): `OPEN=0, ACCEPTED=1, SUBMITTED=2,
 * DISPUTED=3, RELEASED=4, REFUNDED=5, CANCELLED=6`. Only this one value,
 * decoded from a `TaskNotOpen` revert, actually means "a different
 * candidate already accepted" (Codex review, T-804 round 1, P2). */
const TASK_STATUS_ACCEPTED = 1;

/** Thrown by `buildAcceptTaskTx` (方案 A) and `confirmAcceptTaskOnChain` (方案 A
 * 第二阶段 / 方案 B) once either path has positively identified "already accepted by someone
 * else" — a dedicated type (rather than a generic `Error`) so the two throw
 * sites share one source of truth for the message instead of each hand-writing
 * a copy that could drift apart. */
class TaskAlreadyAcceptedError extends Error {
  constructor() {
    super(TASK_ALREADY_ACCEPTED_MESSAGE);
    this.name = "TaskAlreadyAcceptedError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 方案 B (design.md): a short, bounded polling window — not a persistent
// background job — run entirely within this component's own lifecycle
// (`pollForAlreadyAccepted` below checks `mountedRef` before every step so it
// stops the moment the component unmounts). Values are this Task's own
// reasonable choice (capsule explicitly leaves them non-configurable): a few
// seconds is enough for `GET /tasks/:taskId` to observe the other
// candidate's already-committed OPEN→ACCEPTED transition without leaving the
// user staring at a spinner for long.
const POLL_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 1000;

export interface AcceptConfirmContentProps {
  taskId: string;
  /** Already-computed by `AcceptanceSection` — `AcceptanceSection`'s own
   * button disables itself while this is `undefined`, so by the time this
   * component ever mounts it is always a real amount. Kept as a required
   * `bigint` prop (not re-derived here) so this component has exactly one
   * source for the stake amount, matching `FundingStep`'s `intent.budget`
   * precedent. */
  stake: bigint;
  onAccepted?: () => void;
}

type PermitLoadState =
  | { status: "loading" }
  /** Covers both a 404 (no usable permit at all) and a permit whose
   * `expiry` has already lapsed between the GET and now (AC-804's "防止
   * GET 调用和实际点击之间的时间差" case) — both render the identical
   * "过期或不可用" state, since neither offers any actionable recovery
   * other than refreshing. */
  | { status: "unavailable" }
  | { status: "ready"; permit: AcceptancePermitRecord };

/**
 * `GET /tasks/:taskId/my-acceptance-permit`'s response (T-803 capsule,
 * design.md v1.3 — confirmed with the user) deliberately does not include
 * the on-chain `bytes32 taskId` `TaskEscrow.acceptTask`'s `AcceptancePermit`
 * struct requires — only the original UUID. `apps/api`'s
 * `onchain-task-id.ts` documents this value as a pure, permanently-stable
 * function of the UUID (`keccak256(utf8(taskId))`), specifically so it can
 * be recomputed anywhere from the same source string without drift risk;
 * this is that same computation, mirrored here rather than adding a field
 * to the already-confirmed response contract.
 */
function deriveOnChainTaskId(taskId: string): `0x${string}` {
  return keccak256(toBytes(taskId));
}

function isPermitUsable(permit: AcceptancePermitRecord): boolean {
  return permit.expiry > Math.floor(Date.now() / 1000);
}

/**
 * T-803: the "approve stake + acceptTask" confirmation panel mounted inside
 * an `ActionSheet` from `AcceptanceSection`'s "质押接单" button. Structurally
 * identical to `TaskCreatePage.tsx`'s `FundingStep` (the project's one
 * established "approve + business transaction" pattern, design.md's
 * confirmed 方案 B: two independent `useTransactionFlow` instances inlined
 * here, no dedicated Hook) — the only real differences are: (1) an
 * `AcceptancePermit` must be fetched before the second step's `buildTx` can
 * run at all, and (2) the fetched permit's `expiry` gates whether any
 * confirm action is offered (AC-804).
 */
export function AcceptConfirmContent({ taskId, stake, onAccepted }: AcceptConfirmContentProps) {
  const wallet = useWallet();
  const address = wallet.address;
  const [permitState, setPermitState] = useState<PermitLoadState>({ status: "loading" });

  // Read by `pollForAlreadyAccepted` (方案 B) before every poll step, mirroring
  // this file's existing `ignore`-flag pattern for the permit-fetch effect
  // below — a `ref` (not that local `ignore` flag) because the poll runs from
  // inside `confirmOnChain`, called well after any single `useEffect` body has
  // returned, not from within an effect itself.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Explicitly set `true` on every setup, not just relied on as the
    // `useRef` initial value (Codex review, T-804 round 1, P1): this app
    // renders under React StrictMode (main.tsx), which in development runs
    // setup→cleanup→setup again for every effect. The first cleanup below
    // sets this to `false`; without re-setting it here on the second
    // setup, it stays permanently `false` for the component's entire real
    // lifetime, silently disabling `pollForAlreadyAccepted` (方案 B) in
    // every StrictMode-rendered environment — i.e. normal local dev.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 方案 B fallback: neither `buildAcceptTaskTx`'s immediate revert-decode nor
  // a bare receipt failure could positively identify the reason, so ask the
  // backend directly whether the task moved to ACCEPTED under a wallet other
  // than the one this component is running as. A transient `getTask` failure
  // during the window is treated as "not yet determined" (keep polling), not
  // as evidence either way — this is a bounded best-effort check, not the
  // authoritative source of truth for the failure.
  async function pollForAlreadyAccepted(): Promise<boolean> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      if (!mountedRef.current) return false;
      let task;
      try {
        task = await getTask(taskId);
      } catch {
        continue;
      }
      if (!mountedRef.current) return false;
      if (
        task.status === "ACCEPTED" &&
        task.acceptedAgentAddress &&
        (!address || task.acceptedAgentAddress.toLowerCase() !== address.toLowerCase())
      ) {
        return true;
      }
    }
    return false;
  }

  useEffect(() => {
    let ignore = false;
    setPermitState({ status: "loading" });
    getMyAcceptancePermit(taskId)
      .then((permit) => {
        if (ignore) return;
        setPermitState(
          isPermitUsable(permit) ? { status: "ready", permit } : { status: "unavailable" },
        );
      })
      .catch(() => {
        // A 404 (no usable permit) and any other fetch failure both land
        // here as "unavailable" — there is no actionable recovery this
        // component can offer beyond refreshing the page either way (T-803
        // capsule's AC-804 note).
        if (!ignore) setPermitState({ status: "unavailable" });
      });
    return () => {
      ignore = true;
    };
  }, [taskId]);

  async function confirmOnChain(txHash: `0x${string}`): Promise<{ confirmations: number }> {
    const publicClient = wallet.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error("链上交易执行失败（已回滚）。");
    }
    return { confirmations: 1 };
  }

  // 方案 A 第二阶段 / 方案 B: `acceptTask`-specific confirm — `approve`'s own
  // receipt failure has nothing to do with "already accepted by someone
  // else" (that concept only applies once `acceptTask` itself is the
  // transaction in flight), so only `acceptFlow` below gets the polling
  // fallback; `approveFlow` keeps using the plain `confirmOnChain` above.
  async function confirmAcceptTaskOnChain(
    txHash: `0x${string}`,
  ): Promise<{ confirmations: number }> {
    try {
      return await confirmOnChain(txHash);
    } catch (error) {
      // A mined-but-reverted receipt carries no revert reason on its own
      // (`waitForTransactionReceipt` doesn't decode revert data) — decoding
      // it precisely would mean replaying the call at `receipt.blockNumber`,
      // which the capsule explicitly allows skipping in favor of falling
      // straight through to 方案 B's polling fallback instead.
      if (await pollForAlreadyAccepted()) {
        throw new TaskAlreadyAcceptedError();
      }
      throw error;
    }
  }

  async function buildApproveTx(): Promise<{ hash: `0x${string}` }> {
    if (!address) throw new Error("请先连接 MetaMask 钱包。");
    // Defense in depth beyond `canStart`/`handleStartAccept`'s own check
    // (Codex review, T-803 round 1, P1): `approveFlow.retry()` calls this
    // directly, bypassing `handleStartAccept`'s guard, so a wallet switched
    // mid-flow must still be caught here before signing anything.
    if (
      permitState.status === "ready" &&
      address.toLowerCase() !== permitState.permit.agentWalletAddress.toLowerCase()
    ) {
      throw new Error("当前连接的钱包地址与接单授权不匹配。");
    }
    const walletClient = wallet.getWalletClient();
    const hash = await walletClient.writeContract({
      address: wallet.chainConfig.addresses.ydToken,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [wallet.chainConfig.addresses.taskEscrow, stake],
      account: address,
      chain: null,
    });
    return { hash };
  }

  // approve is not independently re-verified against the backend — same
  // reasoning as FundingStep's `verifyApprove`: reaching chain confirmation
  // is itself sufficient, the business-relevant transaction (`acceptTask`)
  // is the one `verifyAcceptTask` below submits for independent RPC review.
  async function verifyApprove(): Promise<VerifyOutcome> {
    return { outcome: "confirmed" };
  }

  const approveFlow = useTransactionFlow({
    buildTx: buildApproveTx,
    confirm: confirmOnChain,
    verify: verifyApprove,
  });

  async function buildAcceptTaskTx(): Promise<{ hash: `0x${string}` }> {
    if (!address) throw new Error("请先连接 MetaMask 钱包。");
    if (permitState.status !== "ready") {
      throw new Error("接单授权不可用或已过期，请刷新页面重试。");
    }
    const { permit } = permitState;
    if (address.toLowerCase() !== permit.agentWalletAddress.toLowerCase()) {
      throw new Error("当前连接的钱包地址与接单授权不匹配。");
    }
    // Re-checked again here, immediately before broadcast (Codex review,
    // T-803 round 2, P2) — not just once at click time: `approve`'s own
    // confirmation wait can itself cross `expiry`, and this function is
    // also called directly by `acceptFlow.retry()`, bypassing
    // `handleStartAccept`'s click-time check entirely. Either path must
    // not still broadcast an `acceptTask` call the contract will
    // unconditionally revert (`PermitExpired`).
    if (!isPermitUsable(permit)) {
      setPermitState({ status: "unavailable" });
      throw new Error("接单授权已过期，请刷新页面重试。");
    }
    const walletClient = wallet.getWalletClient();
    let hash: `0x${string}`;
    try {
      hash = await walletClient.writeContract({
        address: wallet.chainConfig.addresses.taskEscrow,
        abi: TASK_ESCROW_ACCEPT_TASK_ABI,
        functionName: "acceptTask",
        args: [
          {
            taskId: deriveOnChainTaskId(taskId),
            agent: permit.agentWalletAddress,
            nonce: BigInt(permit.nonce),
            expiry: BigInt(permit.expiry),
            chainId: BigInt(permit.chainId),
            verifyingContract: permit.verifyingContract,
          },
          permit.signature,
        ],
        account: address,
        chain: null,
      });
    } catch (error) {
      // 方案 A: the wallet/RPC's pre-broadcast `eth_call` simulation caught the
      // revert before ever signing. viem attaches the decoded custom error to
      // the thrown `BaseError`'s cause chain rather than the top-level error,
      // so `.walk()` is what finds it — not string-matching `error.message`
      // (capsule explicitly rules that out; contract-side text isn't a stable
      // identifier the way the decoded ABI error name is).
      if (error instanceof BaseError) {
        const revertError = error.walk((err) => err instanceof ContractFunctionRevertedError);
        if (
          revertError instanceof ContractFunctionRevertedError &&
          revertError.data?.errorName === "TaskNotOpen"
        ) {
          // `TaskNotOpen(bytes32 taskId, TaskStatus status)` fires for EVERY
          // non-OPEN status, not only `ACCEPTED` (Codex review, T-804 round
          // 1, P2) — `contracts/src/TaskEscrow.sol`'s `TaskStatus` enum
          // order is `OPEN=0, ACCEPTED=1, SUBMITTED=2, DISPUTED=3,
          // RELEASED=4, REFUNDED=5, CANCELLED=6`. Only status `1` actually
          // means "a different candidate already accepted"; any other
          // value (most plausibly `CANCELLED`) means something else
          // happened and must not be misreported as "已被接单".
          const decodedStatus = revertError.data.args?.[1];
          if (Number(decodedStatus) === TASK_STATUS_ACCEPTED) {
            throw new TaskAlreadyAcceptedError();
          }
        }
      }
      throw error;
    }
    return { hash };
  }

  async function verifyAcceptTask(txHash: `0x${string}`): Promise<VerifyOutcome> {
    try {
      const result = await submitAcceptanceVerification(taskId, txHash);
      if ("status" in result) {
        return { outcome: "confirmed" };
      }
      // 202 "still pending" shape — same F-606-derived contract as
      // `verifyCreateTask`: must stay recoverable, never `failed`.
      return { outcome: "rpcUnavailable", error: result.error.message };
    } catch (error) {
      // Same classification `verifyCreateTask` (TaskCreatePage.tsx) uses:
      // a recognized `ErrorCode` is a genuine business rejection; anything
      // else (network failure, or an unrecognized code) rethrows so
      // `useTransactionFlow` treats it as `rpcRecoveryPending` instead of a
      // hard failure. T-804 (a later Task) is what adds a dedicated
      // "already accepted by someone else" message on top of this —
      // here it is enough that a `TaskNotOpen`-style revert or backend
      // rejection lands as `failed`/`rpcRecoveryPending` without crashing.
      if (error instanceof ApiError && error.code && isErrorCode(error.code)) {
        return { outcome: "rejected", errorCode: error.code };
      }
      throw error;
    }
  }

  const acceptFlow = useTransactionFlow({
    buildTx: buildAcceptTaskTx,
    confirm: confirmAcceptTaskOnChain,
    verify: verifyAcceptTask,
  });

  // The session address decided candidacy/permit issuance, but the actual
  // on-chain transaction signs with whatever wallet is CURRENTLY connected
  // — the two can diverge (account switched in MetaMask after this permit
  // was fetched, or a different account than the signed-in session).
  // `acceptTask` requires `permit.agent == msg.sender` and reverts
  // otherwise, so without this check a mismatched wallet would complete a
  // real, paid `approve` transaction before the doomed `acceptTask` even
  // has a chance to fail (Codex review, T-803 round 1, P1).
  const walletMismatch =
    permitState.status === "ready" &&
    (!address || address.toLowerCase() !== permitState.permit.agentWalletAddress.toLowerCase());

  async function handleStartAccept() {
    // Re-check expiry at the moment the user actually clicks, not just at
    // GET-time (Codex review, T-803 round 1, P2): a panel left open past
    // `permit.expiry` must not still let `approve` succeed before
    // `acceptTask` inevitably reverts on an expired permit.
    if (permitState.status !== "ready" || !isPermitUsable(permitState.permit)) {
      setPermitState({ status: "unavailable" });
      return;
    }
    const approveResult = await approveFlow.start();
    if (approveResult.outcome !== "confirmed") return;
    const acceptResult = await acceptFlow.start();
    if (acceptResult.outcome === "confirmed") {
      onAccepted?.();
    }
  }

  // A successful "重试授权" must still continue on to `acceptTask` — same
  // as `handleStartAccept`'s own first-attempt sequencing (Codex review,
  // T-804 round 2, P2): discarding `approveFlow.retry()`'s result left a
  // successful retry stuck with approve `confirmed` but `acceptFlow` never
  // started, and the main button permanently disabled (`canStart` requires
  // `approveFlow.status.kind === "idle"`) — the only way forward would have
  // been closing and reopening the panel.
  async function handleRetryApprove() {
    const approveResult = await approveFlow.retry();
    if (approveResult.outcome !== "confirmed") return;
    const acceptResult = await acceptFlow.start();
    if (acceptResult.outcome === "confirmed") {
      onAccepted?.();
    }
  }

  // A successful "重试接单" must call `onAccepted` too, same as a first
  // attempt (Codex review, T-804 round 2, P2): the parent's `ActionSheet`
  // close-on-success behavior depends on this callback, so a retry that
  // confirms must not silently skip it.
  async function handleRetryAccept() {
    const acceptResult = await acceptFlow.retry();
    if (acceptResult.outcome === "confirmed") {
      onAccepted?.();
    }
  }

  const permitReady = permitState.status === "ready";
  const canStart =
    permitReady &&
    !walletMismatch &&
    approveFlow.status.kind === "idle" &&
    acceptFlow.status.kind === "idle";
  const approveRecoverable =
    approveFlow.status.kind === "rpcRecoveryPending" || approveFlow.status.kind === "failed";
  // T-804: "already accepted by someone else" can surface as either a
  // `failed` status (方案 A: `buildAcceptTaskTx` decoded the revert before
  // ever broadcasting) or a `rpcRecoveryPending` status (方案 A 第二阶段 / 方案
  // B: the failure was only discovered after `confirmAcceptTaskOnChain`'s
  // receipt/poll step, which `useTransactionFlow`'s `confirm` failure path
  // always routes through `rpcRecoveryPending`, never `failed`) — both carry
  // the same fixed message, so both are checked here.
  const acceptAlreadyAccepted =
    (acceptFlow.status.kind === "failed" &&
      isTaskAlreadyAcceptedReason(acceptFlow.status.reason)) ||
    (acceptFlow.status.kind === "rpcRecoveryPending" &&
      isTaskAlreadyAcceptedReason(acceptFlow.status.lastError));
  const acceptFailedDeterministically =
    acceptFlow.status.kind === "failed" &&
    (isErrorCode(acceptFlow.status.reason) || acceptAlreadyAccepted);
  const acceptRecoverable =
    !acceptAlreadyAccepted &&
    (acceptFlow.status.kind === "rpcRecoveryPending" ||
      (acceptFlow.status.kind === "failed" && !acceptFailedDeterministically));
  const acceptDone = acceptFlow.status.kind === "confirmed";

  return (
    <div className="w-full max-w-md p-6">
      <h2 className="mb-4 text-[18px] font-semibold text-ink-primary">确认质押接单</h2>

      {permitState.status === "loading" && (
        <p className="text-caption text-ink-secondary">正在核对接单授权…</p>
      )}

      {permitState.status === "unavailable" && (
        <p role="alert" className="text-caption text-warning">
          接单授权已过期或不可用，请刷新页面查看任务当前状态。
        </p>
      )}

      {permitReady && (
        <div className="flex flex-col gap-4">
          <p className="text-caption text-ink-secondary">质押金额：{formatAmount(stake)} YD</p>

          <div className="flex items-center justify-between text-caption">
            <span className="font-medium text-ink-primary">第一步：授权（approve）</span>
            <TransactionStatusView status={approveFlow.status} />
          </div>
          {approveRecoverable && (
            <button
              type="button"
              onClick={() => void handleRetryApprove()}
              className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm"
            >
              重试授权
            </button>
          )}

          <div className="flex items-center justify-between text-caption">
            <span className="font-medium text-ink-primary">第二步：接单（acceptTask）</span>
            <TransactionStatusView status={acceptFlow.status} />
          </div>
          {acceptRecoverable && (
            <button
              type="button"
              onClick={() => void handleRetryAccept()}
              className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm"
            >
              重试接单
            </button>
          )}
          {acceptAlreadyAccepted && (
            <p role="alert" className="text-caption text-warning">
              {TASK_ALREADY_ACCEPTED_MESSAGE}
            </p>
          )}
          {acceptFailedDeterministically && !acceptAlreadyAccepted && (
            <p role="alert" className="text-caption text-warning">
              该交易已被后端复核明确拒绝，重新发起交易无法解决，请刷新页面查看任务当前状态。
            </p>
          )}

          {!wallet.isCorrectNetwork && (
            <p role="alert" className="text-caption text-warning">
              当前网络不正确，请先切换到 {wallet.chainConfig.name} 后再发起交易。
            </p>
          )}

          {walletMismatch && (
            <p role="alert" className="text-caption text-warning">
              当前连接的钱包地址与接单授权不匹配，请在 MetaMask 中切换到正确的账户后重试。
            </p>
          )}

          {acceptDone ? (
            <p className="text-caption text-success">接单成功。</p>
          ) : (
            <button
              type="button"
              disabled={!canStart || !wallet.isCorrectNetwork}
              onClick={() => void handleStartAccept()}
              className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              开始质押接单
            </button>
          )}
        </div>
      )}
    </div>
  );
}
