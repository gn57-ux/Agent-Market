import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatAmount, isErrorCode, parseAmount } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { useSession } from "../session/SessionProvider.js";
import { SignInButton } from "../session/SignInButton.js";
import { ConfirmAction } from "../../shared/components/ConfirmAction.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow, type VerifyOutcome } from "../../shared/tx-flow/useTransactionFlow.js";
import { ERC20_APPROVE_ABI, TASK_ESCROW_CREATE_TASK_ABI } from "./abi.js";
import {
  ApiError,
  createDraft,
  createFundingIntent,
  getTask,
  submitFundingVerification,
  type CreateDraftInput,
  type FundingIntent,
  type TaskRecord,
} from "./api.js";

interface TaskFormValues {
  category: string;
  skillTagsText: string;
  title: string;
  description: string;
  budgetText: string;
  /** `<input type="datetime-local">`'s own value format (no timezone) —
   * converted to a UTC ISO string only at submit time (`toDeliveryDeadlineIso`). */
  deliveryDeadlineLocal: string;
}

function emptyFormValues(): TaskFormValues {
  return {
    category: "",
    skillTagsText: "",
    title: "",
    description: "",
    budgetText: "",
    deliveryDeadlineLocal: "",
  };
}

function toDeliveryDeadlineIso(localValue: string): string {
  return new Date(localValue).toISOString();
}

/**
 * F-609: budget must cross into contract-call territory as a minimal-unit
 * unsigned integer, never a hand-parsed decimal. `parseAmount` requires the
 * token's actual `decimals` to convert correctly — hardcoding
 * `DEFAULT_DECIMALS` (18) here would silently mis-scale the amount by
 * whatever factor the real deployed token's decimals differ by (e.g. a
 * 6-decimal token, as WalletProvider's own test fixture uses), turning a
 * user's "100" into a wildly wrong on-chain transfer. `ydDecimals` is
 * therefore required as a parameter, not defaulted — see the caller for
 * where it's sourced from (WalletProvider's already-fetched YD balance).
 */
function toCreateDraftInput(values: TaskFormValues, ydDecimals: number): CreateDraftInput {
  const skillTags = values.skillTagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    category: values.category.trim(),
    skillTags,
    title: values.title.trim(),
    description: values.description.trim(),
    budget: parseAmount(values.budgetText.trim(), ydDecimals).toString(),
    deliveryDeadline: toDeliveryDeadlineIso(values.deliveryDeadlineLocal),
  };
}

type Stage =
  | { kind: "loadingResume" }
  | { kind: "form" }
  | { kind: "draft"; task: TaskRecord }
  | { kind: "funding"; task: TaskRecord; intent: FundingIntent }
  // Resuming `?taskId=` for a task already at OPEN or any later status
  // (ACCEPTED/SUBMITTED/DISPUTED/RELEASED/REFUNDED/CANCELLED) — funding is
  // already complete, nothing left for this page to do. Deliberately NOT
  // re-requesting a funding intent for these: `createFundingIntent` only
  // accepts DRAFT/AWAITING_FUNDING and 409s otherwise (Codex review, T-606
  // round 1, P2).
  | { kind: "completed"; task: TaskRecord };

const inputClasses =
  "w-full rounded-input border border-divider-light bg-canvas-light px-4 py-2.5 text-body text-ink-primary placeholder:text-ink-secondary focus:border-action-blue focus:outline-none focus:ring-2 focus:ring-action-blue/20";
const labelClasses = "flex flex-col gap-1.5 text-caption font-medium text-ink-secondary";

interface StepIndicatorProps {
  current: "info" | "funding";
}

/** design.md's Create Task guidance: "calm multi-step form with visible
 * progress, persistent summary and explicit wallet transaction stages." A
 * two-step indicator (填写任务信息 → 资金锁定) rather than the Stitch reference's
 * four-substep breakdown — this page's actual state machine has exactly two
 * server-meaningful phases (draft, then funding); a four-step visual with no
 * corresponding state would be decoration, not information. */
function StepIndicator({ current }: StepIndicatorProps) {
  const steps: { key: StepIndicatorProps["current"]; label: string }[] = [
    { key: "info", label: "填写任务信息" },
    { key: "funding", label: "锁定预算" },
  ];
  return (
    <ol className="mb-8 flex items-center gap-3 text-caption text-ink-secondary">
      {steps.map((step, index) => (
        <li key={step.key} className="flex items-center gap-3">
          <span
            className={
              step.key === current
                ? "flex h-7 w-7 items-center justify-center rounded-full bg-action-blue text-white"
                : "flex h-7 w-7 items-center justify-center rounded-full border border-divider-light text-ink-secondary"
            }
          >
            {index + 1}
          </span>
          <span className={step.key === current ? "font-medium text-ink-primary" : undefined}>
            {step.label}
          </span>
          {index < steps.length - 1 && <span className="mx-1 h-px w-8 bg-divider-light" />}
        </li>
      ))}
    </ol>
  );
}

/**
 * F-601–F-604, F-609, F-612: draft form → funding-intent → two explicitly
 * orchestrated `useTransactionFlow` calls (`approve` then `createTask`).
 *
 * Not wrapped in `ActionSheet`: that component is built for a compact
 * confirm-then-fire action layered over other content (e.g. a list item's
 * contextual action) where dismissing the overlay leaves the underlying
 * page intact. Here the funding step IS the page's own primary content —
 * its transaction status (awaitingSignature/confirming/rpcRecoveryPending/
 * retry) needs to stay persistently visible and is exactly what
 * `TransactionStatusView` renders inline; a modal a user could Escape out of
 * mid-signature would just add a confusing extra state to reconcile
 * against, not a coherent affordance. `ConfirmAction` is used instead for
 * the single "发起资金锁定" trigger — a real "are you sure" gate before
 * spending gas on the first of two real transactions.
 */
export function TaskCreatePage() {
  const wallet = useWallet();
  const session = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [formValues, setFormValues] = useState<TaskFormValues>(emptyFormValues());
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [fundingIntentError, setFundingIntentError] = useState<string | undefined>(undefined);
  // Generated once per form-filling session, not once per submit attempt:
  // if the server actually created the draft but the response was lost
  // (network blip) and the user retries after seeing the error, a FRESH
  // key on that retry would defeat the whole point of Idempotency-Key —
  // the server sees an unrecognized key and creates a second draft (Codex
  // review, T-606 round 1, P2). `null` means "no key committed to yet";
  // set on first submit, cleared on success (a later, genuinely new draft
  // gets its own fresh key) or when the form is reset for `?taskId=`
  // resume/navigation away.
  const idempotencyKeyRef = useRef<string | null>(null);

  const resumeTaskId = searchParams.get("taskId");

  // F-607/AC-605: a draft is server-persisted state — reloading this page
  // (or returning to it) with `?taskId=` in the URL resumes the same task
  // instead of starting the form over. The URL (not localStorage) is the
  // persistence key: `handleDraftSubmitted`/`handleFundingIntentRequested`
  // below write the created taskId into it via `setSearchParams`, so a
  // plain browser refresh already lands back here with the id present.
  useEffect(() => {
    if (!resumeTaskId) {
      setStage({ kind: "form" });
      return;
    }
    let ignore = false;
    setStage({ kind: "loadingResume" });
    getTask(resumeTaskId)
      .then(async (task) => {
        if (ignore) return;
        if (task.status === "DRAFT") {
          setStage({ kind: "draft", task });
          return;
        }
        if (task.status !== "AWAITING_FUNDING") {
          // OPEN or any later status — already funded, nothing to resume
          // (see Stage's "completed" doc comment for why this must not
          // call createFundingIntent).
          setStage({ kind: "completed", task });
          return;
        }
        // AWAITING_FUNDING: re-request the funding intent, which
        // `createFundingIntent` returns idempotently for an
        // already-AWAITING_FUNDING task (service.ts) — this is not a new
        // side effect, just re-deriving the same transaction parameters to
        // resume the funding step's UI.
        const intent = await createFundingIntent(task.taskId);
        if (ignore) return;
        setStage({ kind: "funding", task, intent });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        // A 404 here can legitimately mean "this DRAFT/AWAITING_FUNDING
        // task belongs to someone else" — but it can also mean "it's MY
        // task, the session cookie is still valid server-side, but this
        // page's own `session.status` hasn't caught up to signed_in yet"
        // (SessionProvider has no automatic session-restore-on-load step —
        // see its own doc comment). Re-running this effect once
        // `session.status` actually changes (dependency array below) is
        // what lets a subsequent real sign-in recover the same task
        // instead of leaving the user stuck on a blank form that invites
        // creating a duplicate draft (Codex review, T-606 round 2, P1).
        if (error instanceof ApiError && error.status === 404 && session.status !== "signed_in") {
          setFormError("未检测到登录状态，请先登录后再尝试恢复该任务。");
        } else {
          setFormError(
            error instanceof ApiError ? error.message : "恢复任务草稿失败，请刷新页面重试。",
          );
        }
        setStage({ kind: "form" });
      });
    return () => {
      ignore = true;
    };
  }, [resumeTaskId, session.status]);

  const ydDecimals =
    wallet.connection.status === "connected" && wallet.connection.ydBalance.status === "ready"
      ? wallet.connection.ydBalance.decimals
      : undefined;

  async function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ydDecimals === undefined) {
      setFormError("正在读取 YD 代币精度，请稍候再提交。");
      return;
    }
    setFormPending(true);
    setFormError(undefined);
    try {
      const input = toCreateDraftInput(formValues, ydDecimals);
      if (idempotencyKeyRef.current === null) {
        idempotencyKeyRef.current =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`;
      }
      const created = await createDraft(input, idempotencyKeyRef.current);
      const task = await getTask(created.taskId);
      // Success — this key's job is done. A later, genuinely new draft
      // (e.g. the user navigates back to a fresh /tasks/new) gets its own.
      idempotencyKeyRef.current = null;
      setSearchParams({ taskId: created.taskId });
      setStage({ kind: "draft", task });
    } catch (error) {
      // Deliberately does NOT clear idempotencyKeyRef here — a retry after
      // this failure must reuse the same key (see the ref's own doc
      // comment for why).
      setFormError(error instanceof ApiError ? error.message : "创建草稿失败，请重试。");
    } finally {
      setFormPending(false);
    }
  }

  async function handleRequestFunding(task: TaskRecord) {
    setFundingIntentError(undefined);
    try {
      const intent = await createFundingIntent(task.taskId);
      setStage({ kind: "funding", task, intent });
    } catch (error) {
      setFundingIntentError(
        error instanceof ApiError ? error.message : "发起资金锁定失败，请重试。",
      );
    }
  }

  if (stage.kind === "loadingResume") {
    return (
      <section className="mx-auto max-w-reading px-gutter-mobile py-16 md:px-gutter-desktop">
        <p className="text-body text-ink-secondary">正在恢复任务草稿…</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-reading px-gutter-mobile py-16 md:px-gutter-desktop">
      <h1 className="mb-3 text-display-mobile text-ink-primary md:text-display">发布任务</h1>
      <div className="mb-8">
        <SignInButton />
      </div>

      {session.status !== "signed_in" ? (
        <p className="text-body text-ink-secondary">登录钱包身份后才能发布任务。</p>
      ) : stage.kind === "completed" ? (
        <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
          <p className="text-body text-ink-primary">
            该任务的资金锁定已完成，当前状态为「{stage.task.status}」。
          </p>
          <p className="mt-2 text-caption text-ink-secondary">
            任务详情页尚未上线，可前往
            <Link to="/tasks/mine" className="text-action-blue">
              我的发布
            </Link>
            查看。
          </p>
        </div>
      ) : stage.kind === "funding" ? (
        <FundingStep task={stage.task} intent={stage.intent} />
      ) : stage.kind === "draft" ? (
        <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
          <StepIndicator current="funding" />
          <DraftSummary task={stage.task} />
          {fundingIntentError && (
            <p role="alert" className="mt-4 text-caption text-warning">
              {fundingIntentError}
            </p>
          )}
          <div className="mt-6">
            <ConfirmAction
              label="发起资金锁定"
              confirmLabel="确认锁定预算？"
              onConfirm={() => void handleRequestFunding(stage.task)}
            />
          </div>
        </div>
      ) : (
        <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
          <StepIndicator current="info" />
          {ydDecimals === undefined && (
            <p className="mb-4 text-caption text-ink-secondary">
              {wallet.connection.status === "connected"
                ? "正在读取 YD 代币精度…"
                : "请先连接 MetaMask 钱包，用于读取 YD 代币精度并在后续锁定预算。"}
            </p>
          )}
          <form onSubmit={(event) => void handleFormSubmit(event)} className="flex flex-col gap-5">
            <label className={labelClasses}>
              分类
              <input
                value={formValues.category}
                onChange={(event) =>
                  setFormValues((current) => ({ ...current, category: event.target.value }))
                }
                required
                className={inputClasses}
              />
            </label>
            <label className={labelClasses}>
              技能标签（逗号分隔）
              <input
                value={formValues.skillTagsText}
                onChange={(event) =>
                  setFormValues((current) => ({ ...current, skillTagsText: event.target.value }))
                }
                className={inputClasses}
              />
            </label>
            <label className={labelClasses}>
              标题
              <input
                value={formValues.title}
                onChange={(event) =>
                  setFormValues((current) => ({ ...current, title: event.target.value }))
                }
                required
                className={inputClasses}
              />
            </label>
            <label className={labelClasses}>
              描述
              <textarea
                value={formValues.description}
                onChange={(event) =>
                  setFormValues((current) => ({ ...current, description: event.target.value }))
                }
                required
                rows={5}
                className={inputClasses}
              />
            </label>
            <label className={labelClasses}>
              预算（YD，十进制）
              <input
                type="text"
                inputMode="decimal"
                pattern="^\d+(\.\d+)?$"
                title="非负十进制数字，例如 100 或 100.5（不支持科学计数法）"
                value={formValues.budgetText}
                onChange={(event) =>
                  setFormValues((current) => ({ ...current, budgetText: event.target.value }))
                }
                required
                className={inputClasses}
              />
            </label>
            <label className={labelClasses}>
              截止时间
              <input
                type="datetime-local"
                value={formValues.deliveryDeadlineLocal}
                onChange={(event) =>
                  setFormValues((current) => ({
                    ...current,
                    deliveryDeadlineLocal: event.target.value,
                  }))
                }
                required
                className={inputClasses}
              />
            </label>
            {formError && (
              <p role="alert" className="text-caption text-warning">
                {formError}
              </p>
            )}
            <button
              type="submit"
              disabled={formPending || ydDecimals === undefined}
              className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {formPending ? "保存中…" : "保存草稿"}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function DraftSummary({ task }: { task: TaskRecord }) {
  return (
    <dl className="grid grid-cols-1 gap-3 text-caption sm:grid-cols-2">
      <div>
        <dt className="text-ink-secondary">标题</dt>
        <dd className="text-ink-primary">{task.title}</dd>
      </div>
      <div>
        <dt className="text-ink-secondary">分类</dt>
        <dd className="text-ink-primary">{task.category}</dd>
      </div>
      <div>
        <dt className="text-ink-secondary">预算（最小单位）</dt>
        <dd className="text-ink-primary">{task.budget}</dd>
      </div>
      <div>
        <dt className="text-ink-secondary">截止时间</dt>
        <dd className="text-ink-primary">{new Date(task.deliveryDeadline).toLocaleString()}</dd>
      </div>
    </dl>
  );
}

interface FundingStepProps {
  task: TaskRecord;
  intent: FundingIntent;
}

/**
 * F-603/F-604/AC-609: two independently instantiated `useTransactionFlow`
 * calls, sequenced explicitly in `handleStartFunding` — exactly design.md's
 * orchestration example (`approveResult.outcome !== 'confirmed'` short-
 * circuits before `fundingFlow.start()` is ever called). Both hooks are
 * declared unconditionally at the top of this component (rules of hooks);
 * their `buildTx`/`verify` closures read `intent`/`task` from props, which
 * are only non-null once this component is mounted (i.e. once the parent's
 * `stage.kind === "funding"`), so there is no real path where `buildTx`
 * fires before `intent` exists.
 */
function FundingStep({ task, intent }: FundingStepProps) {
  const wallet = useWallet();
  const address = wallet.address;
  // Display-only: falls back to DEFAULT_DECIMALS(18) if the balance read
  // hasn't resolved yet (e.g. resumed via `?taskId=` before WalletProvider's
  // balance effect completes) — unlike the draft-form step, no amount is
  // parsed from user input here, so a wrong fallback only misformats a
  // label, never mis-scales a transaction (`intent.budget`, already a
  // minimal-unit integer from the backend, is used as-is in `buildTx` below).
  const ydDecimals =
    wallet.connection.status === "connected" && wallet.connection.ydBalance.status === "ready"
      ? wallet.connection.ydBalance.decimals
      : 18;

  async function confirmOnChain(txHash: `0x${string}`): Promise<{ confirmations: number }> {
    const publicClient = wallet.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error("链上交易执行失败（已回滚）。");
    }
    return { confirmations: 1 };
  }

  async function buildApproveTx(): Promise<{ hash: `0x${string}` }> {
    if (!address) throw new Error("请先连接 MetaMask 钱包。");
    const walletClient = wallet.getWalletClient();
    const hash = await walletClient.writeContract({
      address: intent.token,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [intent.contractAddress, BigInt(intent.budget)],
      account: address,
      chain: null,
    });
    return { hash };
  }

  // approve is not independently re-verified against the backend (capsule:
  // "approve 本身不需要后端复核，后端复核的是 createTask 那笔") — reaching chain
  // confirmation (via `confirm` above) is itself sufficient for this step;
  // the transaction whose business effect actually matters, `createTask`,
  // is the one `verifyCreateTask` below submits for independent RPC review.
  async function verifyApprove(): Promise<VerifyOutcome> {
    return { outcome: "confirmed" };
  }

  const approveFlow = useTransactionFlow({
    buildTx: buildApproveTx,
    confirm: confirmOnChain,
    verify: verifyApprove,
  });

  async function buildCreateTaskTx(): Promise<{ hash: `0x${string}` }> {
    if (!address) throw new Error("请先连接 MetaMask 钱包。");
    const walletClient = wallet.getWalletClient();
    const hash = await walletClient.writeContract({
      address: intent.contractAddress,
      abi: TASK_ESCROW_CREATE_TASK_ABI,
      functionName: "createTask",
      args: [
        intent.taskIdOnChain,
        intent.token,
        BigInt(intent.budget),
        BigInt(intent.deliveryDeadline),
      ],
      account: address,
      chain: null,
    });
    return { hash };
  }

  async function verifyCreateTask(txHash: `0x${string}`): Promise<VerifyOutcome> {
    try {
      const result = await submitFundingVerification(task.taskId, txHash);
      if ("status" in result) {
        return { outcome: "confirmed" };
      }
      // 202 "still pending" shape (TRANSACTION_NOT_CONFIRMED /
      // RPC_TEMPORARILY_UNAVAILABLE) — F-606 requires this stay recoverable,
      // never `failed`.
      return { outcome: "rpcUnavailable", error: result.error.message };
    } catch (error) {
      // `error.code as ErrorCode` previously trusted ANY string the server
      // sent back as if it were one of the fixed domain `ErrorCode` values
      // — an unrecognized/future code would have been silently treated as
      // a deterministic business rejection (skipping the retry button) even
      // though nothing here actually knows what it means (human review,
      // T-606 round 3). `isErrorCode` is the same guard `fundingFailedDeterministically`
      // below uses to decide whether to show a retry button, so this and
      // that check must agree on what counts as "a real domain rejection" —
      // an ApiError whose `code` isn't a recognized ErrorCode falls through
      // to the same rethrow as no `code` at all.
      if (error instanceof ApiError && error.code && isErrorCode(error.code)) {
        // A genuine 400/409 rejection (FUNDING_EVENT_MISMATCH,
        // TRANSACTION_ALREADY_USED, CHAIN_UNSUPPORTED, TRANSACTION_NOT_FOUND)
        // — a real business rejection, not a transient one.
        return { outcome: "rejected", errorCode: error.code };
      }
      // Unexpected/network failure, or an ApiError with an unrecognized
      // `code`: rethrow so useTransactionFlow treats it as
      // rpcRecoveryPending (its own documented behavior for a thrown
      // verify()), not a hard failure.
      throw error;
    }
  }

  const fundingFlow = useTransactionFlow({
    buildTx: buildCreateTaskTx,
    confirm: confirmOnChain,
    verify: verifyCreateTask,
  });

  async function handleStartFunding() {
    const approveResult = await approveFlow.start();
    if (approveResult.outcome !== "confirmed") return;
    await fundingFlow.start();
  }

  const canStart = approveFlow.status.kind === "idle" && fundingFlow.status.kind === "idle";
  const approveRecoverable =
    approveFlow.status.kind === "rpcRecoveryPending" || approveFlow.status.kind === "failed";
  // `fundingFlow`'s `failed` status conflates two very different causes
  // (useTransactionFlow's `VerifyOutcome.rejected` and a genuine buildTx/
  // confirm throw both land as `{kind:"failed", reason}`): a build/
  // signature failure (safe to retry — `retry()` re-signs and rebroadcasts
  // a brand-new createTask attempt) vs. a DETERMINISTIC backend rejection
  // of an ALREADY-MINED transaction (FUNDING_EVENT_MISMATCH,
  // TRANSACTION_ALREADY_USED, TRANSACTION_NOT_FOUND, CHAIN_UNSUPPORTED —
  // `verifyCreateTask` sets `reason` to exactly one of these `ErrorCode`
  // values in that case). Offering "重试锁定" for the latter would
  // rebroadcast a SECOND createTask transaction for a task whose first one
  // may have already succeeded on-chain — wasted gas at best, a confusing
  // double-funding attempt at worst (Codex review, T-606 round 2, P2).
  // `isErrorCode` is what distinguishes them: a generic thrown Error's
  // `.message` (e.g. "user rejected the request") is never itself one of
  // the fixed `ErrorCode` string values.
  const fundingFailedDeterministically =
    fundingFlow.status.kind === "failed" && isErrorCode(fundingFlow.status.reason);
  const fundingRecoverable =
    fundingFlow.status.kind === "rpcRecoveryPending" ||
    (fundingFlow.status.kind === "failed" && !fundingFailedDeterministically);
  const fundingDone = fundingFlow.status.kind === "confirmed";

  return (
    <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
      <StepIndicator current="funding" />
      <DraftSummary task={task} />

      <div className="mt-6 flex flex-col gap-4 border-t border-divider-light pt-6">
        <div className="flex items-center justify-between text-caption">
          <span className="font-medium text-ink-primary">第一步：授权（approve）</span>
          <TransactionStatusView status={approveFlow.status} />
        </div>
        {approveRecoverable && (
          <button
            type="button"
            onClick={() => void approveFlow.retry()}
            className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm"
          >
            重试授权
          </button>
        )}

        <div className="flex items-center justify-between text-caption">
          <span className="font-medium text-ink-primary">第二步：锁定预算（createTask）</span>
          <TransactionStatusView status={fundingFlow.status} />
        </div>
        {fundingRecoverable && (
          <button
            type="button"
            onClick={() => void fundingFlow.retry()}
            className="self-start rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm"
          >
            重试锁定
          </button>
        )}
        {fundingFailedDeterministically && (
          <p role="alert" className="text-caption text-warning">
            该交易已被后端复核明确拒绝，重新发起交易无法解决（可能已有一笔链上交易被处理），请刷新页面查看任务当前状态，或联系支持处理。
          </p>
        )}

        {!wallet.isCorrectNetwork && (
          <p role="alert" className="text-caption text-warning">
            当前网络不正确，请先切换到 {wallet.chainConfig.name} 后再发起交易。
          </p>
        )}

        {fundingDone ? (
          <p className="text-caption text-success">预算已锁定，任务已开放招募。</p>
        ) : (
          <button
            type="button"
            disabled={!canStart || !wallet.isCorrectNetwork}
            onClick={() => void handleStartFunding()}
            className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            开始锁定预算（{formatAmount(BigInt(intent.budget), ydDecimals)} YD）
          </button>
        )}
      </div>
    </div>
  );
}
