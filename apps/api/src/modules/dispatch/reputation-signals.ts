import type { Queryable } from "../../db/pool.js";

/**
 * v0.2's five-signal scoring input for one Agent (F-1306/F-1308) — field
 * names match design.md's wire contract and Go's `domain.ReputationSignals`
 * exactly, so `dispatch/routes.ts` (T-1303) can forward this object
 * unchanged into the `POST /match` request body. `null` means that signal
 * is genuinely missing (F-1309) — never a fabricated 0 or a borrowed
 * prior; this module computes raw values only, never decides how they
 * combine into a final score (F-1306's "调用方不得复制公式" boundary —
 * that belongs exclusively to `services/dispatch/internal/scoring`).
 */
export interface ReputationSignalsInput {
  completionRate: number | null;
  qualityFeedback: number | null;
  communication: number | null;
  disputeSignal: number | null;
  historicalScale: number | null;
}

/** One signal's persisted digest entry (F-1313, Feature 13/T-1307):
 * `value` is the exact number (or `null`) this signal contributed to
 * `ReputationSignalsInput`; `sampleSize` is how many real data points
 * backed it — the window's settled-task count for the four window-based
 * signals, or the Agent's lifetime `completed_task_count` for
 * `historicalScale` (which isn't window-based at all — F-1307 explicitly
 * excludes it from the 90-day/50-task window). `sampleSize` is always a
 * real count, even when `value` is `null` (a `sampleSize` of 0 IS the
 * reason `value` is `null` — F-1309's missing-value case), so a later
 * reader can distinguish "no data" from "a real zero-fraction result."
 */
export interface ReputationSignalDigestEntry {
  value: number | null;
  sampleSize: number;
}

/**
 * F-1313: the full persisted "input feature summary" for one candidate's
 * v0.2 score — AC-1307's "五个信号各自的原始值+窗口内任务数" requirement.
 * `recommendation_candidates.reputation_signals` (T-1300's migration)
 * stores exactly this shape per candidate on a "v0.2" run, so a later
 * reader has enough to reconstruct — not just "what score did this
 * candidate get," but "how many real settled tasks/ratings actually
 * backed each signal that produced it." Never sent to Go as-is — see
 * `toReputationSignalsWire` for the flat-values projection Go's wire
 * contract (design.md, T-1305) actually expects.
 */
export interface ReputationSignalsDigest {
  completionRate: ReputationSignalDigestEntry;
  qualityFeedback: ReputationSignalDigestEntry;
  communication: ReputationSignalDigestEntry;
  disputeSignal: ReputationSignalDigestEntry;
  historicalScale: ReputationSignalDigestEntry;
}

/** Projects a `ReputationSignalsDigest` down to the flat `{signal: value}`
 * shape `dispatch/routes.ts` (T-1303) attaches to each wire
 * `CandidateSnapshot` — the ONLY shape Go's `matchReputationSignals`
 * struct (T-1305) is decoded against; `sampleSize` never reaches Go, it
 * exists purely for this module's own persisted digest (T-1307). */
export function toReputationSignalsWire(digest: ReputationSignalsDigest): ReputationSignalsInput {
  return {
    completionRate: digest.completionRate.value,
    qualityFeedback: digest.qualityFeedback.value,
    communication: digest.communication.value,
    disputeSignal: digest.disputeSignal.value,
    historicalScale: digest.historicalScale.value,
  };
}

/** F-1307's window: only settled tasks within this many days... */
const WINDOW_DAYS = 90;
/** ...and, among those, only the most recent this many. Both constraints
 * apply together — a task older than WINDOW_DAYS is excluded even if the
 * agent has fewer than WINDOW_MAX_TASKS settled tasks in total. Both
 * numbers are trusted, hardcoded, spec-confirmed constants (never derived
 * from request input), so interpolating them directly into the SQL text
 * below carries none of the injection risk string-interpolating a request
 * value would. */
const WINDOW_MAX_TASKS = 50;

/** F-1308's historical-completion-scale divisor: `min(completedTaskCount /
 * HISTORICAL_SCALE_DIVISOR, 1)`. Unlike the other four signals, this one
 * uses `agents.completed_task_count` directly (Feature 10's existing
 * lifetime counter) — no window query needed for it. */
const HISTORICAL_SCALE_DIVISOR = 20;

/** `task_id`/`on_time`/`rating_score`/`communication_score`/`has_dispute`
 * are all `null` on the one sentinel row an agent with zero window entries
 * still gets (Codex review round 1, P2 fix — see `assembleReputationSignals`'s
 * query, which drives FROM `agents` via a LEFT JOIN specifically so every
 * requested agent always has at least one row in the SAME query result,
 * with `completed_task_count` — never a second, separately-snapshotted
 * query). `computeSignals` filters those sentinel rows out of `window`
 * before computing anything. */
interface AgentSignalRow {
  agent_id: string;
  completed_task_count: number;
  task_id: string | null;
  on_time: boolean | null;
  rating_score: number | null;
  communication_score: number | null;
  has_dispute: boolean | null;
}

interface WindowedSettlementRow {
  task_id: string;
  on_time: boolean;
  rating_score: number | null;
  communication_score: number | null;
  has_dispute: boolean;
}

/** Normalizes a 1-5 star rating to [0,1] — same formula as `ratings/
 * service.ts`'s `aggregateQualityScore` (`(score-1)/4`), duplicated here
 * rather than imported: that function operates on a whole Agent's ALL
 * historical scores for v0.1's `agents.quality_score`, a materially
 * different aggregation (no window, no on-time/dispute/communication
 * signals) — importing it here would misleadingly suggest the two
 * calculations share more than the one normalization constant they
 * actually share. */
function normalizeStars(score: number): number {
  return (score - 1) / 4;
}

function computeSignals(
  window: WindowedSettlementRow[],
  completedTaskCount: number,
): ReputationSignalsDigest {
  const completionRate =
    window.length === 0 ? null : window.filter((row) => row.on_time).length / window.length;

  const rated = window.filter((row) => row.rating_score !== null);
  const qualityFeedback =
    rated.length === 0
      ? null
      : rated.reduce((sum, row) => sum + normalizeStars(row.rating_score as number), 0) /
        rated.length;

  const withCommunication = window.filter((row) => row.communication_score !== null);
  const communication =
    withCommunication.length === 0
      ? null
      : withCommunication.reduce(
          (sum, row) => sum + normalizeStars(row.communication_score as number),
          0,
        ) / withCommunication.length;

  const disputeSignal =
    window.length === 0 ? null : 1 - window.filter((row) => row.has_dispute).length / window.length;

  // F-1309/F-1312: "全部五项均缺失" is defined as EQUIVALENT to
  // "Agent 无任何历史结算任务" (completedTaskCount === 0) — not merely
  // "this formula happens to evaluate to a falsy number." Returning `0`
  // here instead of `null` for a genuinely history-less Agent would leave
  // historicalScale as the one "present" signal while the other four are
  // correctly null, so ScoreV2 would compute a real (if trivial) weighted
  // average instead of taking the dedicated "no historical sample" path —
  // silently reintroducing the exact TOP_SCORE-ranking bug T-1304's round
  // 2 fix closed, just via a different code path.
  const historicalScale =
    completedTaskCount === 0 ? null : Math.min(completedTaskCount / HISTORICAL_SCALE_DIVISOR, 1);

  return {
    completionRate: { value: completionRate, sampleSize: window.length },
    qualityFeedback: { value: qualityFeedback, sampleSize: rated.length },
    communication: { value: communication, sampleSize: withCommunication.length },
    disputeSignal: { value: disputeSignal, sampleSize: window.length },
    historicalScale: { value: historicalScale, sampleSize: completedTaskCount },
  };
}

/**
 * F-1306/F-1307/F-1308: batch-computes every requested Agent's v0.2
 * reputation signals in exactly ONE query (the windowed settlement data
 * all four window-based signals share, joined with `completed_task_count`
 * in the same statement so both come from the same database snapshot —
 * see the query's own comment for why a second, separate query was a real
 * race, Codex review round 1 P2) — never one query per Agent. `dispatch/
 * routes.ts`'s `matchTask` (T-1303) is this function's only caller,
 * passing the full candidate pool's AgentIDs after `assembleCandidateSnapshots`
 * has already fetched them.
 *
 * An Agent whose entire window is empty (never settled a task in the last
 * `WINDOW_DAYS` days) still gets a map entry — all five fields `null` if
 * `completedTaskCount` is also 0, or just the four window-based fields
 * `null` with a real `historicalScale` if they have older lifetime history
 * outside the window (F-1309 applies per-signal, not all-or-nothing,
 * except for the specific all-five case `computeSignals` documents).
 *
 * Returns the full `ReputationSignalsDigest` (value + sampleSize per
 * signal, F-1313) — not the flat `ReputationSignalsInput` Go's wire
 * contract expects. Callers building a `CandidateSnapshot` for `POST
 * /match` must project through `toReputationSignalsWire` first; callers
 * persisting `recommendation_candidates.reputation_signals` (T-1307) use
 * the digest directly.
 */
export async function assembleReputationSignals(
  pool: Queryable,
  agentIds: string[],
): Promise<Map<string, ReputationSignalsDigest>> {
  const result = new Map<string, ReputationSignalsDigest>();
  if (agentIds.length === 0) {
    return result;
  }

  // Codex review round 1 (P2): windowed settlement data and
  // completed_task_count used to come from two SEPARATE queries. Under
  // Postgres's default READ COMMITTED isolation, each statement gets its
  // OWN snapshot — if a task's settlement transaction committed in the gap
  // between the two (incrementing completed_task_count and inserting the
  // matching task_state_history row together, atomically), the first query
  // could see an empty window while the second already saw the incremented
  // count. That combination — completedTaskCount > 0 but every window
  // signal null — can never actually exist in the database at any single
  // instant (a nonzero completedTaskCount's most recent completion is
  // necessarily also the newest row the window query would find), yet the
  // torn read would feed ScoreV2 as if it did. One query = one snapshot
  // for its entire execution, closing the gap structurally rather than
  // trying to time the two reads carefully.
  //
  // Driven FROM `agents` (LEFT JOIN into the window data) so every
  // requested agentId gets at least one row — including an agent with zero
  // window entries, which the windowed-only version of this query used to
  // just omit entirely, requiring a second query to recover
  // completed_task_count for.
  const { rows } = await pool.query<AgentSignalRow>(
    `WITH candidate_tasks AS (
       -- Codex review round 2 (P2), Feature 13/T-1306: filter to the
       -- requested agents' OWN tasks FIRST, via
       -- tasks_accepted_agent_status_idx (accepted_agent_id, status) —
       -- before this CTE existed, settlement_events scanned and sorted
       -- every RELEASED/REFUNDED row in the whole task_state_history table
       -- on every call, a platform-history-sized cost paid per /match
       -- request regardless of how few candidates were actually being
       -- scored. Every later CTE only ever touches rows already narrowed
       -- to these agents' own tasks.
       SELECT id AS task_id, accepted_agent_id AS agent_id, delivery_deadline
       FROM tasks
       WHERE accepted_agent_id = ANY($1)
     ),
     settlement_events AS (
       -- F-1307: "最近一次转移时间" — RELEASED/REFUNDED are terminal
       -- (never transitioned out of again), so DISTINCT ON here is
       -- defensive against a hypothetical duplicate row, not something
       -- the normal task lifecycle can actually produce.
       SELECT DISTINCT ON (tsh.task_id) tsh.task_id, tsh.occurred_at
       FROM task_state_history tsh
       JOIN candidate_tasks ct ON ct.task_id = tsh.task_id
       WHERE tsh.to_status IN ('RELEASED', 'REFUNDED')
       ORDER BY tsh.task_id, tsh.occurred_at DESC
     ),
     windowed AS (
       SELECT
         ct.agent_id,
         ct.task_id,
         (se.occurred_at <= ct.delivery_deadline) AS on_time,
         se.occurred_at,
         -- Codex review round 1 (P2), Feature 13/T-1307 N6 QA: ct.task_id
         -- is a real tiebreaker, not just a formality — two settlements for
         -- the same agent can share the exact same occurred_at (e.g. a
         -- batch settlement, or plain timestamp-precision collision), and
         -- without a deterministic secondary key, a tie straddling the
         -- WINDOW_MAX_TASKS boundary lets Postgres pick an ARBITRARY
         -- subset of the tied rows as "inside" vs "outside" the window on
         -- each execution — the same database state could then produce
         -- different reputation signals (and downstream v0.2 scores/
         -- recommendations) for the same task/candidate set, violating
         -- AC-1306. Same "unique secondary key breaks ties deterministically"
         -- convention this project already established for
         -- recommendation_runs (requested_at + sequence_no) and
         -- slotting.Select (Score + AgentID).
         ROW_NUMBER() OVER (
           PARTITION BY ct.agent_id ORDER BY se.occurred_at DESC, ct.task_id ASC
         ) AS rn
       FROM settlement_events se
       JOIN candidate_tasks ct ON ct.task_id = se.task_id
       WHERE se.occurred_at >= now() - INTERVAL '${WINDOW_DAYS} days'
     )
     SELECT
       a.id AS agent_id,
       a.completed_task_count,
       w.task_id,
       w.on_time,
       r.score AS rating_score,
       r.communication_score,
       CASE WHEN w.task_id IS NULL THEN NULL
            ELSE EXISTS (SELECT 1 FROM disputes d WHERE d.task_id = w.task_id) END AS has_dispute
     FROM agents a
     LEFT JOIN windowed w ON w.agent_id = a.id AND w.rn <= ${WINDOW_MAX_TASKS}
     LEFT JOIN ratings r ON r.task_id = w.task_id
     WHERE a.id = ANY($1)`,
    [agentIds],
  );

  const windowByAgentId = new Map<string, WindowedSettlementRow[]>();
  const completedCountByAgentId = new Map<string, number>();
  for (const row of rows) {
    completedCountByAgentId.set(row.agent_id, row.completed_task_count);
    if (row.task_id === null) {
      // The sentinel "no window entries" row — nothing to add to window.
      continue;
    }
    const entry: WindowedSettlementRow = {
      task_id: row.task_id,
      on_time: row.on_time as boolean,
      rating_score: row.rating_score,
      communication_score: row.communication_score,
      has_dispute: row.has_dispute as boolean,
    };
    const existing = windowByAgentId.get(row.agent_id);
    if (existing) {
      existing.push(entry);
    } else {
      windowByAgentId.set(row.agent_id, [entry]);
    }
  }

  for (const agentId of agentIds) {
    const window = windowByAgentId.get(agentId) ?? [];
    const completedTaskCount = completedCountByAgentId.get(agentId) ?? 0;
    result.set(agentId, computeSignals(window, completedTaskCount));
  }

  return result;
}
