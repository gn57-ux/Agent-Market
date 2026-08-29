import { useEffect, useState } from "react";
import { formatAmount } from "@agent-market/domain";
import { CandidateSection } from "../recommendations/CandidateSection.js";
import { getRecommendations } from "../recommendations/api.js";
import { getAgent } from "../agents/api.js";
import { ApiError, getTask, type TaskRecord } from "../tasks/api.js";
import { TASK_ESCROW_STAKE_RATE_BPS_ABI } from "../tasks/abi.js";
import { useSession } from "../session/SessionProvider.js";
import { useWallet } from "../wallet/WalletProvider.js";
import { ActionSheet } from "../../shared/action-sheet/ActionSheet.js";
import { AcceptConfirmContent } from "./AcceptConfirmContent.js";

export interface AcceptanceSectionProps {
  taskId: string;
  /** Notifies the task-detail owner to reload its authoritative status. */
  onAccepted?: () => void;
}

/** One recommended Agent the signed-in wallet owns for this task — see
 * `resolveCandidateAgentIds`'s doc comment for why this is a list, not a
 * single value. */
export interface CandidateAgentOption {
  agentId: string;
  agentName: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "not_candidate" }
  | { status: "ready"; task: TaskRecord; candidates: CandidateAgentOption[] }
  | { status: "error"; message: string };

const SECTION_CLASSES = "mt-8 rounded-card border border-divider-light bg-surface-light p-6 md:p-8";

// Generic BPS base (10_000 = 100.00%), not a business rule this Feature
// owns — `TaskEscrow.BPS_DENOMINATOR` is `private`, so this is the literal
// value confirmed against `contracts/src/TaskEscrow.sol` (capsule).
const BPS_DENOMINATOR = 10_000n;

/**
 * Determines ALL (T-807 round 2, human N4 BLOCK fix) of this task's (at
 * most 3, F-704's hard slot cap) `GET .../recommendations` `agentId`s the
 * signed-in wallet owns, by fetching each one's own Agent record and
 * comparing `ownerAddress` against the session address.
 * `GET /tasks/:taskId/recommendations`'s response has no wallet address
 * (design.md's fixed, already-shipped contract —
 * `agentId/rank/slotType/score/reasons`) and `GET /agents` has no `owner`
 * query filter (`listAgentsQuerySchema` in apps/api's schema.ts) — this
 * reverses the lookup instead of asking either existing endpoint to grow a
 * field/filter it doesn't have for this Feature's sake (capsule's "经验"
 * note).
 *
 * Returns EVERY matched `agentId`/`agentName`, in `recommendations`' own
 * rank order — NOT just the first match. A previous version of this
 * function returned only one `agentId` under the assumption "a wallet owns
 * at most one recommended Agent per task," which is FALSE: the backend
 * explicitly supports and tests this (`routes.integration.test.ts`'s
 * "returns each candidate's own independent permit when the same wallet
 * owns two recommended candidates" — two Agent records under one owner
 * address, both recommended, each with its own permit via `GET
 * /tasks/:taskId/agents/:agentId/acceptance-permit`, T-806). Silently
 * picking the first match would hide the second Agent's invitation from
 * the user entirely, with no way to accept as it. The caller now decides
 * how to handle 0 / 1 / >1 matches (`AcceptanceSection`'s "ready" state
 * carries the whole list; >1 requires an explicit pick before mounting
 * `AcceptConfirmContent`, which still only ever acts as a single
 * `agentId`).
 */
async function resolveCandidateAgentIds(
  taskId: string,
  sessionAddress: string,
): Promise<CandidateAgentOption[]> {
  const { recommendations } = await getRecommendations(taskId);
  const matches = await Promise.all(
    recommendations.map((candidate) =>
      getAgent(candidate.agentId).then(
        (agent) =>
          agent.ownerAddress === sessionAddress
            ? { agentId: candidate.agentId, agentName: agent.name }
            : undefined,
        () => undefined, // an individual Agent lookup failing must not fail the whole check
      ),
    ),
  );
  return matches.filter((match): match is CandidateAgentOption => match !== undefined);
}

/**
 * Owns the OPEN section's entry point for `TaskDetailSections.tsx` (design.md:
 * "加一行 import { AcceptanceSection } ... 把返回值...分支为 CandidateSection 或
 * AcceptanceSection") — the composition root's `case "OPEN":` stays a single
 * unconditional `<AcceptanceSection taskId={taskId} />` (capsule's own
 * verification note: "改动只是一行 import + 一个 case"). The actual
 * "CandidateSection or AcceptanceSection" decision lives HERE instead,
 * because it can only be resolved after an async fetch, and
 * FundingSection/CandidateSection's own established convention is "each
 * section fetches its own data" — not "TaskDetailSections grows a hook of
 * its own to pick between sibling sections".
 *
 * Every non-candidate outcome (signed out, still loading, owns none of the
 * ≤3 recommended Agents, or the candidacy check itself failed) renders
 * Feature 7's `CandidateSection` unchanged — a fail-open default, so a
 * regression in this Feature can only ever show the recommendations list a
 * non-candidate visitor already relies on, never hide it.
 *
 * The stake/acceptTask transaction itself is `AcceptConfirmContent` (T-803),
 * mounted here via `ActionSheet` once "质押接单" is clicked — this component
 * only owns opening/closing the sheet and computing `stake`, not the
 * transaction flow inside it.
 */
export function AcceptanceSection({ taskId, onAccepted }: AcceptanceSectionProps) {
  const session = useSession();
  const wallet = useWallet();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [stake, setStake] = useState<bigint | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  // T-807 round 2 fix: which of possibly several owned candidate Agents the
  // user wants to act as. Auto-selected below when there is exactly one
  // (the common case, unchanged UX); left `undefined` — forcing an explicit
  // pick — when the wallet owns more than one recommended candidate for
  // this task, so a second owned Agent is never silently hidden.
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let ignore = false;
    setState({ status: "loading" });

    if (session.status !== "signed_in" || !session.address) {
      setState({ status: "not_candidate" });
      return;
    }
    const sessionAddress = session.address;

    // A candidacy-check failure (recommendations/agent lookup) must fail
    // open to Feature 7's existing view, per this component's own doc
    // comment — this `.catch` is scoped to ONLY that first async stage
    // (Codex review, T-802 round 1, P2): without it, an `ApiError` thrown by
    // `resolveCandidateAgentIds` and one thrown by the LATER `getTask` call
    // both landed in the same final `.catch` below and were treated
    // identically as a real "error" state, contradicting the fail-open
    // behavior this component documents and is tested for.
    resolveCandidateAgentIds(taskId, sessionAddress)
      .catch(() => [] as CandidateAgentOption[])
      .then((candidates) => {
        if (ignore || candidates.length === 0) {
          if (!ignore) setState({ status: "not_candidate" });
          return undefined;
        }
        return getTask(taskId).then((task) => ({ task, candidates }));
      })
      .then((result) => {
        if (!ignore && result) {
          setState({ status: "ready", task: result.task, candidates: result.candidates });
        }
      })
      .catch((error: unknown) => {
        // Only a `getTask` failure (AFTER candidacy is already confirmed)
        // can reach here now — there is nothing sensible to render for a
        // confirmed candidate without the task record itself, so EVERY
        // failure here becomes an error state, not just `ApiError`
        // instances (Codex review, T-802 round 2, P2): `apiFetch` can also
        // reject with a raw `TypeError` for a transport-level failure
        // (offline, DNS, CORS) that never reaches its `ApiError`-throwing
        // branch — treating that as `not_candidate` would misleadingly
        // render the confirmed candidate as ineligible instead of surfacing
        // the real load failure.
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载任务详情失败。",
        });
      });

    return () => {
      ignore = true;
    };
  }, [taskId, session.status, session.address]);

  // Auto-select the only candidate (the common case) so the flow is
  // unchanged for a wallet that owns exactly one recommended Agent here;
  // reset to "no selection yet" whenever the candidate list itself changes
  // (a re-fetch, or the wallet switching to a different set of owned
  // Agents) rather than carrying a stale selection over.
  useEffect(() => {
    if (state.status !== "ready") {
      setSelectedAgentId(undefined);
      return;
    }
    const [onlyCandidate] = state.candidates;
    setSelectedAgentId(state.candidates.length === 1 ? onlyCandidate?.agentId : undefined);
  }, [state]);

  useEffect(() => {
    if (state.status !== "ready") {
      setStake(undefined);
      return;
    }
    let ignore = false;
    const { budget } = state.task;
    // `wallet.getPublicClient()` throws SYNCHRONOUSLY (not a rejected
    // Promise) when no wallet is connected — e.g. the user disconnects
    // between this section mounting and this effect running (Codex review,
    // T-802 round 1, P1). Calling it directly and chaining `.then()`/
    // `.catch()` off its result means that synchronous throw happens before
    // any `.catch()` is even attached, crashing the render instead of
    // leaving the stake line as "读取中…". Wrapping the whole read in an
    // async IIFE turns that synchronous throw into a normal rejection this
    // single `try/catch` already handles, the same as any `readContract`
    // failure.
    void (async () => {
      try {
        const stakeRateBps = await wallet.getPublicClient().readContract({
          address: wallet.chainConfig.addresses.taskEscrow,
          abi: TASK_ESCROW_STAKE_RATE_BPS_ABI,
          functionName: "STAKE_RATE_BPS",
        });
        if (!ignore) setStake((BigInt(budget) * stakeRateBps) / BPS_DENOMINATOR);
      } catch {
        // Display-only computation (capsule: no test asserts the rate
        // itself is "correct") — any failure (RPC error, or no wallet
        // connected) just leaves the stake line showing "读取中…" rather
        // than blocking title/budget/deadline, which are already
        // independently useful without it.
      }
    })();
    return () => {
      ignore = true;
    };
  }, [state, wallet]);

  if (state.status === "loading") {
    return (
      <div className={SECTION_CLASSES}>
        <p className="text-body text-ink-secondary">加载中…</p>
      </div>
    );
  }
  if (state.status === "not_candidate") {
    return <CandidateSection taskId={taskId} />;
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

  const { task } = state;

  return (
    <div className={SECTION_CLASSES}>
      <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">接单质押</h2>
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
          <dt className="text-ink-secondary">预算</dt>
          <dd className="text-ink-primary">{formatAmount(BigInt(task.budget))} YD</dd>
        </div>
        <div>
          <dt className="text-ink-secondary">截止时间</dt>
          <dd className="text-ink-primary">{new Date(task.deliveryDeadline).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-ink-secondary">质押金额</dt>
          <dd className="text-ink-primary">
            {stake === undefined ? "读取中…" : `${formatAmount(stake)} YD`}
          </dd>
        </div>
      </dl>

      {state.candidates.length > 1 && (
        // T-807 round 2 fix: this wallet owns more than one of this task's
        // recommended Agents — never silently act as just the first one.
        // `radiogroup`/`radio` (not a plain button list) since exactly one
        // of these must end up chosen before "质押接单" is offered at all.
        <div className="mt-6" role="radiogroup" aria-label="选择用于接单的 Agent">
          <p className="mb-2 text-caption font-medium text-ink-primary">
            你名下有多个 Agent 是本任务的候选，请选择用哪个 Agent 接单：
          </p>
          <div className="flex flex-col gap-2">
            {state.candidates.map((candidate) => (
              <label
                key={candidate.agentId}
                className="flex items-center gap-2 text-caption text-ink-primary"
              >
                <input
                  type="radio"
                  name="candidate-agent"
                  value={candidate.agentId}
                  checked={selectedAgentId === candidate.agentId}
                  onChange={() => setSelectedAgentId(candidate.agentId)}
                />
                {candidate.agentName}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6">
        <button
          type="button"
          disabled={stake === undefined || selectedAgentId === undefined}
          onClick={() => setSheetOpen(true)}
          className="inline-block rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          质押接单
        </button>
      </div>

      {stake !== undefined && selectedAgentId !== undefined && (
        <ActionSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          content={
            <AcceptConfirmContent
              taskId={taskId}
              agentId={selectedAgentId}
              stake={stake}
              onAccepted={() => {
                setSheetOpen(false);
                onAccepted?.();
              }}
            />
          }
          titleForA11y="质押接单"
        />
      )}
    </div>
  );
}
