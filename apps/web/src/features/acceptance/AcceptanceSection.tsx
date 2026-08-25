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
}

type LoadState =
  | { status: "loading" }
  | { status: "not_candidate" }
  | { status: "ready"; task: TaskRecord }
  | { status: "error"; message: string };

const SECTION_CLASSES = "mt-8 rounded-card border border-divider-light bg-surface-light p-6 md:p-8";

// Generic BPS base (10_000 = 100.00%), not a business rule this Feature
// owns — `TaskEscrow.BPS_DENOMINATOR` is `private`, so this is the literal
// value confirmed against `contracts/src/TaskEscrow.sol` (capsule).
const BPS_DENOMINATOR = 10_000n;

/**
 * Determines "is the signed-in wallet one of this task's recommended
 * candidates" by fetching each of the (at most 3, F-704's hard slot cap)
 * `GET .../recommendations` agentIds' own Agent record and comparing
 * `ownerAddress` against the session address. `GET /tasks/:taskId/recommendations`'s
 * response has no wallet address (design.md's fixed, already-shipped
 * contract — `agentId/rank/slotType/score/reasons`) and `GET /agents` has no
 * `owner` query filter (`listAgentsQuerySchema` in apps/api's schema.ts) —
 * this reverses the lookup instead of asking either existing endpoint to
 * grow a field/filter it doesn't have for this Feature's sake (capsule's
 * "经验" note).
 */
async function resolveIsCandidate(taskId: string, sessionAddress: string): Promise<boolean> {
  const { recommendations } = await getRecommendations(taskId);
  const owners = await Promise.all(
    recommendations.map((candidate) =>
      getAgent(candidate.agentId).then(
        (agent) => agent.ownerAddress,
        () => undefined, // an individual Agent lookup failing must not fail the whole check
      ),
    ),
  );
  return owners.some((ownerAddress) => ownerAddress === sessionAddress);
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
export function AcceptanceSection({ taskId }: AcceptanceSectionProps) {
  const session = useSession();
  const wallet = useWallet();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [stake, setStake] = useState<bigint | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);

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
    // `resolveIsCandidate` and one thrown by the LATER `getTask` call both
    // landed in the same final `.catch` below and were treated identically
    // as a real "error" state, contradicting the fail-open behavior this
    // component documents and is tested for.
    resolveIsCandidate(taskId, sessionAddress)
      .catch(() => false)
      .then((isCandidate) => {
        if (ignore || !isCandidate) {
          if (!ignore) setState({ status: "not_candidate" });
          return undefined;
        }
        return getTask(taskId);
      })
      .then((task) => {
        if (!ignore && task) setState({ status: "ready", task });
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

      <div className="mt-6">
        <button
          type="button"
          disabled={stake === undefined}
          onClick={() => setSheetOpen(true)}
          className="inline-block rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          质押接单
        </button>
      </div>

      {stake !== undefined && (
        <ActionSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          content={
            <AcceptConfirmContent
              taskId={taskId}
              stake={stake}
              onAccepted={() => setSheetOpen(false)}
            />
          }
          titleForA11y="质押接单"
        />
      )}
    </div>
  );
}
