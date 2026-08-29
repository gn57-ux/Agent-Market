import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatAmount, isErrorCode, parseAmount } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { FaucetClaimButton } from "../wallet/FaucetClaimButton.js";
import { useSession } from "../session/SessionProvider.js";
import { requestMatch } from "../recommendations/api.js";
import { ConfirmAction } from "../../shared/components/ConfirmAction.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow, type VerifyOutcome } from "../../shared/tx-flow/useTransactionFlow.js";
import {
  ERC20_APPROVE_ABI,
  TASK_ESCROW_CREATE_TASK_ABI,
  TASK_ESCROW_REVIEW_WINDOW_ABI,
  TASK_ESCROW_STAKE_RATE_BPS_ABI,
} from "./abi.js";
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
  skillTags: string[];
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
    skillTags: [],
    title: "",
    description: "",
    budgetText: "",
    deliveryDeadlineLocal: "",
  };
}

function toDeliveryDeadlineIso(localValue: string): string {
  return new Date(localValue).toISOString();
}

/** Task C: `<input type="datetime-local">`'s `min` attribute and the live
 * "is this still in the future" check both need "now" in the exact
 * timezone-less format the input itself uses (`YYYY-MM-DDTHH:mm`) — the
 * backend's own `DELIVERY_DEADLINE_SCHEMA` refinement (`must be > Date.now()`)
 * is the single owner of the actual business rule; this only mirrors that
 * rule client-side so the failure shows up before a wasted round trip, it
 * does not reimplement or loosen it. */
function nowAsDatetimeLocalValue(): string {
  const now = new Date();
  now.setSeconds(0, 0);
  const localTimestamp = now.getTime() - now.getTimezoneOffset() * 60_000;
  return new Date(localTimestamp).toISOString().slice(0, 16);
}

function isDeadlineInFuture(localValue: string): boolean {
  if (!localValue) return false;
  const parsed = new Date(localValue).getTime();
  return Number.isFinite(parsed) && parsed > Date.now();
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
  return {
    category: values.category.trim(),
    skillTags: values.skillTags,
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
  // round 2, P2).
  | { kind: "completed"; task: TaskRecord };

const inputClasses =
  "w-full rounded-input border border-divider-light bg-canvas-light px-4 py-2.5 text-body text-ink-primary placeholder:text-ink-secondary focus:border-action-blue focus:outline-none focus:ring-2 focus:ring-action-blue/20";
const labelClasses = "flex flex-col gap-1.5 text-caption font-medium text-ink-secondary";

const CATEGORY_SUGGESTIONS = ["数据分析", "智能合约", "内容生成", "UI/UX", "后端", "翻译"];

type WizardStep = 1 | 2 | 3 | 4;

const WIZARD_STEPS: { step: WizardStep; label: string }[] = [
  { step: 1, label: "任务信息" },
  { step: 2, label: "匹配要求" },
  { step: 3, label: "预算与期限" },
  { step: 4, label: "确认并托管" },
];

interface WizardProgressProps {
  current: WizardStep;
}

/** design.md's Create Task guidance: "calm multi-step form with visible
 * progress, persistent summary and explicit wallet transaction stages" —
 * docs/stitch_agent_market_landing_page 2's agent_market_create_task_step_1-4
 * (+ mobile siblings) reference. Desktop: a numbered horizontal stepper with
 * a connecting line. Mobile: "STEP X OF 4" plus a thin progress bar — same
 * information, denser for a narrow viewport, matching the mobile reference's
 * own layout rather than just shrinking the desktop version. */
function WizardProgress({ current }: WizardProgressProps) {
  return (
    <div className="mb-8">
      <div className="hidden items-center md:flex" aria-hidden="true">
        {WIZARD_STEPS.map((entry, index) => (
          <div key={entry.step} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2">
              <span
                className={
                  entry.step <= current
                    ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-action-blue text-caption font-medium text-white"
                    : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-divider-light text-caption text-ink-secondary"
                }
              >
                {entry.step < current ? "✓" : entry.step}
              </span>
              <span
                className={
                  entry.step === current
                    ? "whitespace-nowrap text-caption font-medium text-ink-primary"
                    : "whitespace-nowrap text-caption text-ink-secondary"
                }
              >
                {entry.label}
              </span>
            </div>
            {index < WIZARD_STEPS.length - 1 && (
              <span
                className={
                  entry.step < current
                    ? "mx-3 h-px flex-1 bg-action-blue"
                    : "mx-3 h-px flex-1 bg-divider-light"
                }
              />
            )}
          </div>
        ))}
      </div>
      <div className="md:hidden">
        <p className="mb-2 text-caption font-medium text-ink-secondary" aria-live="polite">
          第 {current} 步 / 共 4 步 · {WIZARD_STEPS[current - 1]?.label}
        </p>
        <div className="flex gap-1.5" aria-hidden="true">
          {WIZARD_STEPS.map((entry) => (
            <span
              key={entry.step}
              className={
                entry.step <= current
                  ? "h-1.5 flex-1 rounded-full bg-action-blue"
                  : "h-1.5 flex-1 rounded-full bg-divider-light"
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface TaskSummaryCardProps {
  values: TaskFormValues;
  stakeRateBps: bigint | undefined;
  reviewWindowSeconds: bigint | undefined;
}

// Codex review (N4, P2): `reviewWindow` is a `uint64` seconds value the
// contract accepts as ANY nonzero duration, not just exact multiples of
// 3600 — plain BigInt division truncated the remainder, so e.g. 3599
// seconds (just under an hour) displayed as "0 小时" and silently showed a
// shorter settlement window than the deployment actually configured.
// Formatting the full hh:mm (falling back to minutes for sub-hour
// durations) keeps this an honest read of the real on-chain value.
function formatHours(seconds: bigint): string {
  const totalMinutes = seconds / 60n;
  const hours = totalMinutes / 60n;
  const minutes = totalMinutes % 60n;
  if (hours === 0n) return `${minutes} 分钟`;
  if (minutes === 0n) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}

function stakePreview(budgetText: string, stakeRateBps: bigint | undefined): string {
  if (stakeRateBps === undefined) return "连接钱包后可查看";
  const budget = Number(budgetText);
  if (!budgetText.trim() || Number.isNaN(budget)) return "将在填写预算后计算";
  const percent = Number(stakeRateBps) / 100;
  return `Agent 履约质押 ${percent}%（接单时由 Agent 支付，不从预算中扣除）`;
}

/**
 * design.md's Create Task guidance: "persistent summary" — the right-column
 * (desktop) / stacked (mobile) card every Stitch create-task reference
 * export keeps visible across all 4 steps, live-updating from `formValues`
 * as the visitor fills each step in. Every field here is one this page's
 * own real form state already owns — no field is invented for the summary
 * alone.
 */
function TaskSummaryCard({ values, stakeRateBps, reviewWindowSeconds }: TaskSummaryCardProps) {
  return (
    <aside className="rounded-card border border-divider-light bg-surface-light p-6">
      <h2 className="mb-4 text-body font-semibold text-ink-primary">任务摘要</h2>
      <dl className="flex flex-col gap-3 text-caption">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-secondary">标题</dt>
          <dd className="text-right text-ink-primary">{values.title.trim() || "尚未填写"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-secondary">分类</dt>
          <dd className="text-right text-ink-primary">{values.category.trim() || "尚未选择"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-secondary">技能标签</dt>
          <dd className="text-right text-ink-primary">
            {values.skillTags.length > 0 ? values.skillTags.join("、") : "尚未选择"}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-divider-light pt-3">
          <dt className="text-ink-secondary">预算</dt>
          <dd className="text-right text-ink-primary">
            {values.budgetText.trim() ? `${values.budgetText.trim()} YD Token` : "将在第 3 步设置"}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-secondary">截止时间</dt>
          <dd className="text-right text-ink-primary">
            {values.deliveryDeadlineLocal
              ? new Date(values.deliveryDeadlineLocal).toLocaleString()
              : "将在第 3 步设置"}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-secondary">验收窗口</dt>
          <dd className="text-right text-ink-primary">
            {reviewWindowSeconds === undefined
              ? "连接钱包后可查看"
              : formatHours(reviewWindowSeconds)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-divider-light pt-3">
          <dt className="text-ink-secondary">托管资产</dt>
          <dd className="text-right text-ink-primary">YD Token</dd>
        </div>
      </dl>
      <p className="mt-4 text-caption text-ink-secondary">
        {stakePreview(values.budgetText, stakeRateBps)}
      </p>
      <p className="mt-4 rounded-input bg-canvas-warm p-3 text-caption text-ink-secondary">
        任务资料保存在链下；预算、参与地址和结算状态记录在链上。
      </p>
    </aside>
  );
}

/**
 * F-601–F-604, F-609, F-612: draft form → funding-intent → two explicitly
 * orchestrated `useTransactionFlow` calls (`approve` then `createTask`).
 *
 * The 4-step wizard below (docs/stitch_agent_market_landing_page 2's
 * agent_market_create_task_step_1-4 reference) is a purely client-side UI
 * restructuring of ONE existing form: steps 1-3 only update local
 * `formValues` state and never touch the network. `createDraft` is still
 * called exactly once, from step 4, with the exact same
 * `toCreateDraftInput`-built payload the single-screen form used to submit —
 * no new field, no new backend call, no fabricated on-chain state. Steps
 * 1-3 gate "下一步" on each step's own required fields being non-empty
 * (client-only validation); the server-side Zod schema remains the actual
 * source of truth for validity.
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
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [formValues, setFormValues] = useState<TaskFormValues>(emptyFormValues());
  const [skillTagDraft, setSkillTagDraft] = useState("");
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [fundingIntentError, setFundingIntentError] = useState<string | undefined>(undefined);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [stakeRateBps, setStakeRateBps] = useState<bigint | undefined>(undefined);
  const [reviewWindowSeconds, setReviewWindowSeconds] = useState<bigint | undefined>(undefined);
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

  // Step-3/step-4 informational reads only (design.md's settlement-rules
  // copy) — never authoritative for a transaction amount, matching
  // AcceptanceSection.tsx's identical stake-rate read. Both values are
  // per-deployment contract state, not project-wide constants, so this page
  // reads them rather than hardcoding "6%"/"72 小时" and duplicating
  // knowledge TaskEscrow.sol alone owns.
  useEffect(() => {
    if (wallet.connection.status !== "connected") {
      setStakeRateBps(undefined);
      setReviewWindowSeconds(undefined);
      return;
    }
    let ignore = false;
    const publicClient = wallet.getPublicClient();
    void publicClient
      .readContract({
        address: wallet.chainConfig.addresses.taskEscrow,
        abi: TASK_ESCROW_STAKE_RATE_BPS_ABI,
        functionName: "STAKE_RATE_BPS",
      })
      .then((value) => {
        if (!ignore) setStakeRateBps(value);
      })
      .catch(() => undefined);
    void publicClient
      .readContract({
        address: wallet.chainConfig.addresses.taskEscrow,
        abi: TASK_ESCROW_REVIEW_WINDOW_ABI,
        functionName: "reviewWindow",
      })
      .then((value) => {
        if (!ignore) setReviewWindowSeconds(BigInt(value));
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [wallet]);

  const ydDecimals =
    wallet.connection.status === "connected" && wallet.connection.ydBalance.status === "ready"
      ? wallet.connection.ydBalance.decimals
      : undefined;

  function addSkillTag() {
    const trimmed = skillTagDraft.trim();
    if (!trimmed || formValues.skillTags.includes(trimmed)) {
      setSkillTagDraft("");
      return;
    }
    setFormValues((current) => ({ ...current, skillTags: [...current.skillTags, trimmed] }));
    setSkillTagDraft("");
  }

  function removeSkillTag(tag: string) {
    setFormValues((current) => ({
      ...current,
      skillTags: current.skillTags.filter((existing) => existing !== tag),
    }));
  }

  function handleSkillTagKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addSkillTag();
    }
  }

  async function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ydDecimals === undefined) {
      setFormError("正在读取 YD 代币精度，请稍候再提交。");
      return;
    }
    // Task C: re-check "预算 > 0" / "截止时间晚于当前时间" one more time at
    // the moment of submit, not just when step 3 was filled in — the user
    // can spend arbitrary time on step 4 reading the settlement rules and
    // confirming the checkbox, during which a deadline that was valid when
    // typed can have already passed.
    if (!isDeadlineInFuture(formValues.deliveryDeadlineLocal)) {
      setFormError("交付截止时间必须晚于当前时间，请返回上一步重新选择。");
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

  const step1Valid =
    formValues.title.trim() !== "" &&
    formValues.category.trim() !== "" &&
    formValues.description.trim() !== "";
  // Task C: the previous gate only checked "非空"（non-empty), matching the
  // pattern-only budget check and the missing `min` on the deadline input —
  // a single-character title or a "0" budget or a past deadline could all
  // advance past this gate and only fail once the backend rejected it. Both
  // extra checks mirror rules the backend already owns (BUDGET_SCHEMA's
  // `> 0` refine, DELIVERY_DEADLINE_SCHEMA's `> Date.now()` refine) —
  // re-derived here, not duplicated as a separate source of truth, so a
  // backend rule change can't silently drift out of sync with this gate.
  const budgetNumber = Number(formValues.budgetText);
  const budgetValid =
    formValues.budgetText.trim() !== "" && Number.isFinite(budgetNumber) && budgetNumber > 0;
  const deadlineValid = isDeadlineInFuture(formValues.deliveryDeadlineLocal);
  const step3Valid = budgetValid && deadlineValid;

  return (
    <section className="mx-auto max-w-content px-gutter-mobile py-16 md:px-gutter-desktop">
      <div className="mb-8">
        <h1 className="mb-2 text-display-mobile text-ink-primary md:text-display">
          发布一个新任务
        </h1>
        <p className="text-body text-ink-secondary">
          描述你的需求，系统将为你匹配最合适的 AI Agent。
        </p>
      </div>

      {session.status !== "signed_in" ? (
        <p className="text-body text-ink-secondary">登录钱包身份后才能发布任务。</p>
      ) : stage.kind === "completed" ? (
        <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
          <p className="text-body text-ink-primary">
            该任务的资金锁定已完成，当前状态为「{stage.task.status}」。
          </p>
          <p className="mt-2 text-caption text-ink-secondary">
            可前往
            <Link to={`/tasks/${stage.task.taskId}`} className="text-action-blue">
              任务详情
            </Link>
            查看。
          </p>
        </div>
      ) : stage.kind === "funding" ? (
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr,320px]">
          <div className="order-2 md:order-1">
            <WizardProgress current={4} />
            <FundingStep task={stage.task} intent={stage.intent} />
          </div>
          <div className="order-1 md:order-2">
            <TaskSummaryCard
              values={formValues}
              stakeRateBps={stakeRateBps}
              reviewWindowSeconds={reviewWindowSeconds}
            />
          </div>
        </div>
      ) : stage.kind === "draft" ? (
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr,320px]">
          <div className="order-2 md:order-1">
            <WizardProgress current={4} />
            <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
              <h2 className="mb-4 text-body font-semibold text-ink-primary">确认任务并锁定预算</h2>
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
          </div>
          <div className="order-1 md:order-2">
            <TaskSummaryCard
              values={formValues}
              stakeRateBps={stakeRateBps}
              reviewWindowSeconds={reviewWindowSeconds}
            />
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void handleFormSubmit(event)}>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr,320px]">
            <div className="order-2 md:order-1">
              <WizardProgress current={wizardStep} />
              <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
                {ydDecimals === undefined && (
                  <p className="mb-4 text-caption text-ink-secondary">
                    {wallet.connection.status === "connected"
                      ? "正在读取 YD 代币精度…"
                      : "请先连接 MetaMask 钱包，用于读取 YD 代币精度并在后续锁定预算。"}
                  </p>
                )}

                {wizardStep === 1 && (
                  <div className="flex flex-col gap-5">
                    <h2 className="text-title font-semibold text-ink-primary">
                      告诉我们需要完成什么
                    </h2>
                    <label className={labelClasses} htmlFor="task-title">
                      标题
                      <input
                        id="task-title"
                        value={formValues.title}
                        onChange={(event) =>
                          setFormValues((current) => ({ ...current, title: event.target.value }))
                        }
                        maxLength={200}
                        placeholder="使用一句话清楚说明最终目标"
                        required
                        className={inputClasses}
                      />
                    </label>
                    <label className={labelClasses} htmlFor="task-category">
                      分类
                      <input
                        id="task-category"
                        list="task-category-suggestions"
                        value={formValues.category}
                        onChange={(event) =>
                          setFormValues((current) => ({ ...current, category: event.target.value }))
                        }
                        placeholder="搜索或输入任务分类"
                        required
                        className={inputClasses}
                      />
                      <datalist id="task-category-suggestions">
                        {CATEGORY_SUGGESTIONS.map((option) => (
                          <option key={option} value={option} />
                        ))}
                      </datalist>
                    </label>
                    <label className={labelClasses} htmlFor="task-description">
                      描述
                      <textarea
                        id="task-description"
                        value={formValues.description}
                        onChange={(event) =>
                          setFormValues((current) => ({
                            ...current,
                            description: event.target.value,
                          }))
                        }
                        placeholder="请说明任务背景、需要解决的问题、可以提供的输入资料、期望交付成果以及验收标准。"
                        required
                        rows={6}
                        maxLength={5000}
                        className={inputClasses}
                      />
                    </label>
                  </div>
                )}

                {wizardStep === 2 && (
                  <div className="flex flex-col gap-5">
                    <div>
                      <h2 className="text-title font-semibold text-ink-primary">
                        定义合适的 Agent
                      </h2>
                      <p className="mt-1 text-caption text-ink-secondary">
                        添加技能标签，系统将在任务发布后按分类、技能相似度、完成率和质量分推荐候选
                        Agent。
                      </p>
                    </div>
                    <label className={labelClasses} htmlFor="task-skill-tag-input">
                      必需技能（可选）
                      <div className="flex gap-2">
                        <input
                          id="task-skill-tag-input"
                          value={skillTagDraft}
                          onChange={(event) => setSkillTagDraft(event.target.value)}
                          onKeyDown={handleSkillTagKeyDown}
                          placeholder="搜索并添加技能，例如 Python、SQL，按 Enter 添加"
                          className={inputClasses}
                        />
                        <button
                          type="button"
                          onClick={addSkillTag}
                          className="shrink-0 rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm"
                        >
                          添加
                        </button>
                      </div>
                    </label>
                    {formValues.skillTags.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {formValues.skillTags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-1.5 rounded-control border border-action-blue/30 bg-action-blue/10 px-3 py-1 text-caption font-medium text-action-blue"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeSkillTag(tag)}
                              aria-label={`移除技能标签 ${tag}`}
                              className="text-action-blue hover:opacity-70"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="rounded-input bg-canvas-warm p-4 text-caption text-ink-secondary">
                      推荐机制说明：系统基于状态、分类、技能、钱包等进行初步筛选，并按分类匹配度、技能命中、完成率及质量评分综合打分，采用「2
                      个高分 + 1 个新人探索位」策略推荐候选。推荐权重和新人探索规则由平台统一管理。
                    </p>
                  </div>
                )}

                {wizardStep === 3 && (
                  <div className="flex flex-col gap-5">
                    <h2 className="text-title font-semibold text-ink-primary">
                      设置预算与交付期限
                    </h2>
                    <p className="text-caption text-ink-secondary">
                      预算将在下一步通过钱包锁定至 EVM 托管合约。
                    </p>
                    <label className={labelClasses} htmlFor="task-budget">
                      预算（YD，十进制）
                      <input
                        id="task-budget"
                        type="text"
                        inputMode="decimal"
                        pattern="^\d+(\.\d+)?$"
                        title="非负十进制数字，例如 100 或 100.5（不支持科学计数法）"
                        value={formValues.budgetText}
                        onChange={(event) =>
                          setFormValues((current) => ({
                            ...current,
                            budgetText: event.target.value,
                          }))
                        }
                        required
                        className={inputClasses}
                      />
                      {formValues.budgetText.trim() !== "" && !budgetValid && (
                        <span role="alert" className="text-caption text-warning">
                          预算必须大于 0。
                        </span>
                      )}
                    </label>
                    <label className={labelClasses} htmlFor="task-deadline">
                      交付截止时间
                      <input
                        id="task-deadline"
                        type="datetime-local"
                        value={formValues.deliveryDeadlineLocal}
                        min={nowAsDatetimeLocalValue()}
                        onChange={(event) =>
                          setFormValues((current) => ({
                            ...current,
                            deliveryDeadlineLocal: event.target.value,
                          }))
                        }
                        required
                        className={inputClasses}
                      />
                      {formValues.deliveryDeadlineLocal !== "" && !deadlineValid && (
                        <span role="alert" className="text-caption text-warning">
                          交付截止时间必须晚于当前时间。
                        </span>
                      )}
                    </label>
                    <div className="rounded-input border border-divider-light bg-canvas-warm p-4 text-caption text-ink-secondary">
                      <p className="mb-2 font-medium text-ink-primary">结算规则</p>
                      <ul className="list-disc space-y-1 pl-4">
                        <li>
                          验收窗口：Agent 提交成果后，需求方有
                          {reviewWindowSeconds === undefined
                            ? "一段时间"
                            : ` ${formatHours(reviewWindowSeconds)} `}
                          进行验收或发起争议。
                        </li>
                        <li>正常验收：需求方确认成果后，预算支付给 Agent，履约质押退还 Agent。</li>
                        <li>
                          验收逾期：超过验收窗口且未发起争议，任何地址均可触发合约按规则完成放款。
                        </li>
                        <li>
                          交付逾期：超过交付截止时间且 Agent 未提交成果，需求方可触发合约退款。
                        </li>
                        <li>发起争议：争议后普通超时结算暂停，资金等待仲裁裁决。</li>
                      </ul>
                    </div>
                  </div>
                )}

                {wizardStep === 4 && (
                  <div className="flex flex-col gap-5">
                    <h2 className="text-title font-semibold text-ink-primary">
                      确认任务并锁定预算
                    </h2>
                    <p className="text-caption text-ink-secondary">
                      检查任务信息，确认无误后保存草稿并进入资金锁定。
                    </p>
                    <dl className="grid grid-cols-1 gap-4 rounded-input border border-divider-light bg-canvas-light p-5 text-caption sm:grid-cols-2">
                      <div>
                        <dt className="text-ink-secondary">标题</dt>
                        <dd className="text-ink-primary">{formValues.title}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-secondary">分类</dt>
                        <dd className="text-ink-primary">{formValues.category}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-ink-secondary">描述</dt>
                        <dd className="whitespace-pre-wrap text-ink-primary">
                          {formValues.description}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-ink-secondary">技能标签</dt>
                        <dd className="text-ink-primary">
                          {formValues.skillTags.length > 0 ? formValues.skillTags.join("、") : "无"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-ink-secondary">预算</dt>
                        <dd className="text-ink-primary">{formValues.budgetText} YD Token</dd>
                      </div>
                      <div>
                        <dt className="text-ink-secondary">交付截止时间</dt>
                        <dd className="text-ink-primary">
                          {new Date(formValues.deliveryDeadlineLocal).toLocaleString()}
                        </dd>
                      </div>
                    </dl>
                    <label className="flex items-start gap-2 text-caption text-ink-primary">
                      <input
                        type="checkbox"
                        checked={confirmChecked}
                        onChange={(event) => setConfirmChecked(event.target.checked)}
                        className="mt-0.5"
                      />
                      我确认以上任务信息无误，并理解发布任务需要进行两笔链上交易（授权代币、锁定预算）。
                    </label>
                  </div>
                )}

                {formError && (
                  <p role="alert" className="mt-4 text-caption text-warning">
                    {formError}
                  </p>
                )}

                <div className="mt-8 flex items-center justify-between gap-4">
                  {wizardStep > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setWizardStep((step) => (step > 1 ? ((step - 1) as WizardStep) : step))
                      }
                      className="rounded-control border border-divider-light px-5 py-2.5 text-caption font-medium text-ink-primary hover:bg-canvas-warm"
                    >
                      上一步
                    </button>
                  ) : (
                    <span />
                  )}
                  {wizardStep < 4 ? (
                    <button
                      type="button"
                      disabled={
                        (wizardStep === 1 && !step1Valid) || (wizardStep === 3 && !step3Valid)
                      }
                      onClick={() =>
                        setWizardStep((step) => (step < 4 ? ((step + 1) as WizardStep) : step))
                      }
                      className="rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      下一步：{WIZARD_STEPS[wizardStep]?.label}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={formPending || ydDecimals === undefined || !confirmChecked}
                      className="rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {formPending ? "保存中…" : "保存草稿"}
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="order-1 md:order-2">
              <TaskSummaryCard
                values={formValues}
                stakeRateBps={stakeRateBps}
                reviewWindowSeconds={reviewWindowSeconds}
              />
            </div>
          </div>
        </form>
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

  // Task B ("发布任务...前显示余额、所需金额和差额" / "余额不足时阻止进入
  // approve"): a real on-chain `balanceOf` read, following the exact same
  // pattern AcceptConfirmContent.tsx's `readBalanceAllowance` already
  // established for the accept-task flow (Feature 8) — that precheck never
  // existed here for the create-task flow, which is the actual gap N4 found.
  const [balanceState, setBalanceState] = useState<
    { status: "loading" } | { status: "ready"; balance: bigint } | { status: "error" }
  >({ status: "loading" });
  // N4 review (P2): a successful `FaucetClaimButton` claim only called
  // `wallet.refreshBalance()` — which updates WalletProvider's OWN
  // `connection.ydBalance`, a completely different read this step doesn't
  // even use for its gating decision. This step's own `balanceState` effect
  // depends on address/chainConfig/identityGeneration, none of which a
  // faucet claim changes, so it never re-ran: a user who claimed exactly
  // enough YD to cover the budget stayed stuck on "余额不足" until a full
  // page refresh. Fixed with an explicit `balanceRefreshToken` bumped by
  // `FaucetClaimButton`'s `onClaimed` callback (below) — the one thing a
  // claim actually needs to trigger here: "read this balance again."
  const [balanceRefreshToken, setBalanceRefreshToken] = useState(0);

  useEffect(() => {
    if (!address) return;
    let ignore = false;
    setBalanceState({ status: "loading" });
    const publicClient = wallet.getPublicClient();
    void publicClient
      .readContract({
        address: intent.token,
        abi: [
          {
            type: "function",
            name: "balanceOf",
            stateMutability: "view",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
          },
        ] as const,
        functionName: "balanceOf",
        args: [address],
      })
      .then((balance) => {
        if (!ignore) setBalanceState({ status: "ready", balance });
      })
      .catch(() => {
        if (!ignore) setBalanceState({ status: "error" });
      });
    return () => {
      ignore = true;
    };
    // Depends on `wallet.chainConfig`/`wallet.identityGeneration`, not the
    // whole `wallet` object — matching AcceptConfirmContent.tsx's identical
    // balance/allowance effect. `WalletProvider`'s real context value is
    // `useMemo`-stabilized, but nothing guarantees every consumer of
    // `useWallet()` (including test doubles) returns a referentially stable
    // object; depending on `wallet` itself here re-triggers this effect on
    // every render whenever it doesn't, which sets state synchronously and
    // causes an infinite render loop — a real bug this file's own test
    // suite caught (a hung `vitest run`, not a false positive).
  }, [address, intent.token, wallet.chainConfig, wallet.identityGeneration, balanceRefreshToken]);

  const requiredBudget = BigInt(intent.budget);
  const balanceInsufficient =
    balanceState.status === "ready" && balanceState.balance < requiredBudget;
  const balanceSufficient = balanceState.status === "ready" && !balanceInsufficient;
  const balanceShortfall =
    balanceState.status === "ready" && balanceInsufficient
      ? requiredBudget - balanceState.balance
      : undefined;

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
    const fundingResult = await fundingFlow.start();
    if (fundingResult.outcome === "confirmed") {
      // Matching is best-effort and idempotent. Funding is already
      // authoritative at this point, so a dispatch outage must never turn a
      // successful on-chain lock into a failed funding notification. The
      // task detail retains the same requestMatch call as a retry path.
      try {
        await requestMatch(task.taskId);
      } catch {
        // Deliberately deferred to the task-detail retry path.
      }
    }
  }

  const canStart =
    approveFlow.status.kind === "idle" && fundingFlow.status.kind === "idle" && balanceSufficient;
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
      <DraftSummary task={task} />

      <div className="mt-6 flex flex-col gap-4 border-t border-divider-light pt-6">
        <p className="text-caption font-medium text-ink-primary">资金操作流程</p>
        <div className="flex items-center justify-between text-caption">
          <span className="font-medium text-ink-primary">1. 授权 YD Token</span>
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
          <span className="font-medium text-ink-primary">2. 锁定任务预算</span>
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
        <div className="flex items-center justify-between text-caption">
          <span className="font-medium text-ink-primary">3. 后端独立复核</span>
          <span className="text-ink-secondary">
            {fundingDone ? "已完成" : "锁定交易确认后自动进行"}
          </span>
        </div>
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

        {/* Task B: balance precheck — shown before the user can ever reach
            approve/createTask, matching AcceptConfirmContent.tsx's existing
            balance-insufficient breakdown for the accept-task flow. */}
        {!fundingDone && balanceState.status === "loading" && (
          <p className="text-caption text-ink-secondary">正在读取 YD 余额…</p>
        )}
        {!fundingDone && balanceState.status === "error" && (
          <p role="alert" className="text-caption text-warning">
            读取 YD 余额失败，请刷新页面重试。
          </p>
        )}
        {!fundingDone && balanceInsufficient && (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-caption text-warning">
              YD 余额不足，无法锁定预算。
            </p>
            <dl className="grid grid-cols-3 gap-2 rounded-input bg-canvas-warm p-4 text-caption">
              <div>
                <dt className="text-ink-secondary">当前余额</dt>
                <dd className="text-ink-primary">
                  {balanceState.status === "ready"
                    ? formatAmount(balanceState.balance, ydDecimals)
                    : "—"}{" "}
                  YD
                </dd>
              </div>
              <div>
                <dt className="text-ink-secondary">所需预算</dt>
                <dd className="text-ink-primary">{formatAmount(requiredBudget, ydDecimals)} YD</dd>
              </div>
              <div>
                <dt className="text-warning">缺少</dt>
                <dd className="text-warning">
                  {balanceShortfall !== undefined
                    ? formatAmount(balanceShortfall, ydDecimals)
                    : "—"}{" "}
                  YD
                </dd>
              </div>
            </dl>
            <FaucetClaimButton onClaimed={() => setBalanceRefreshToken((token) => token + 1)} />
          </div>
        )}

        {fundingDone ? (
          <p className="text-caption text-success">预算已锁定，任务已开放招募。</p>
        ) : (
          !balanceInsufficient && (
            <button
              type="button"
              disabled={!canStart || !wallet.isCorrectNetwork}
              onClick={() => void handleStartFunding()}
              className="self-start rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              开始锁定预算（{formatAmount(BigInt(intent.budget), ydDecimals)} YD）
            </button>
          )
        )}
      </div>
    </div>
  );
}
