import type { Pool } from "pg";
import {
  DEFAULT_ATTRIBUTION_WINDOW_MS,
  isAttributedEvent,
  type AttributionCandidate,
} from "../analytics/attribution.js";
import type { ReputationSignalsDigest } from "../dispatch/reputation-signals.js";

/**
 * F-1906/AC-1904 (T-1904): builds one dataset snapshot from
 * `interaction_events` — a pure, deterministic function of the database's
 * current state at `asOf` (no randomness, satisfying AC-1904's "数据集可
 * 复现构建"). The thin CLI wrapper (`scripts/build-ctr-training-dataset.ts`)
 * serializes this function's return value to a versioned file and registers
 * its metadata in `ctr_training_datasets` — this function itself never
 * touches the filesystem, matching this codebase's established
 * `runBackfill`-style split (deep, testable logic function; thin script
 * shell — `scripts/backfill-embeddings.ts`'s own convention).
 *
 * Data model decision (compare 2 approaches, CLAUDE.md 原则 3 — this is a
 * new cross-Task data artifact T-1905 builds directly on):
 *
 * | 维度 | 方案 A（选用）：`ctr_training_datasets` 只登记元数据，实际特征/标签行导出为版本化文件 | 方案 B：把完整特征/标签矩阵直接存进 Postgres（宽表或 JSONB 行） |
 * |---|---|---|
 * | 接口复杂度 | 一张小表（版本号+统计计数+文件路径），训练脚本（T-1905）用标准文件 I/O 读取，不需要新的查询接口 | 需要为训练脚本设计一套"按版本读取全部行"的查询/分页接口，且训练框架（无论是 Node 还是未来引入的 Python 库）通常期望文件输入（CSV/JSONL/Parquet），直接查数据库反而要多一层转换 |
 * | 真实消费者匹配度 | design.md 自己的措辞就是"训练脚本：独立命令行工具"——命令行工具的天然输入输出是文件，不是数据库连接 | 数据库存储对"以后有其他服务也要读这份数据集"这类目前不存在的消费者才有优势 |
 * | 版本不可变性 | 文件一旦写入即不可变（新快照=新文件+新版本号），复现实验只需保留旧文件 | 数据库表理论上也能不可变，但需要额外约束（不允许 UPDATE），文件天然满足 |
 * | 与现有基础设施的一致性 | 与 embedding 部分已经确立的"脚本读数据库、算好东西、落地成产物"模式一致 | 需要新发明一种"训练数据存在数据库里"的模式，这个代码库里没有先例 |
 *
 * 选择方案 A。
 */
export interface CandidateFeatures {
  score: number;
  rank: number;
  slotType: string;
  /** T-1903's own hard rule: this is read verbatim from the candidate's
   * OWN persisted `recommendation_candidates.reputation_signals` row —
   * NEVER recomputed via `assembleReputationSignals`, which reflects
   * CURRENT state and would leak every later settlement/rating/dispute
   * into a historical exposure's features. `null` for a `v0.1` run,
   * which never persists this column (same T-1903 rule). */
  reputationSignals: ReputationSignalsDigest | null;
  /** Same T-1903 reasoning and same `v0.1`-is-null caveat. */
  semanticSimilarity: number | null;
}

export interface TrainingExampleOutcome {
  approved: boolean;
  ratingScore: number | null;
  refunded: boolean;
  disputed: boolean;
}

export interface TrainingExampleRow {
  exposureEventId: string;
  taskId: string;
  agentId: string;
  runId: string | null;
  algorithmVersion: string;
  taskTerminalStatus: "RELEASED" | "REFUNDED" | "CANCELLED";
  candidateFeatures: CandidateFeatures;
  /** True when this candidate was the one actually accepted for the task
   * — false means a real "exposed but not selected" candidate (F-1906's
   * exposure-censoring requirement: kept, not discarded, for future bias
   * analysis; Q-1904 leaves whether a full counterfactual estimator is
   * ever built on top of this as an open question). */
  wasAccepted: boolean;
  /** `null` exactly when `wasAccepted` is `false` — a non-accepted
   * candidate structurally cannot have an ACCEPT/SUBMIT/APPROVE/RATE/
   * REFUND/DISPUTE outcome attributed to it (those all require having
   * actually been the accepted agent). */
  outcome: TrainingExampleOutcome | null;
}

export interface DatasetBuildResult {
  asOf: Date;
  matureExamples: TrainingExampleRow[];
  /** Exposures whose task has not yet reached a terminal status
   * (RELEASED/REFUNDED/CANCELLED) — F-1906's delayed-feedback requirement:
   * these are deliberately excluded from `matureExamples`, not backfilled
   * with an incomplete/guessed label, and left for a future run once the
   * task actually settles. */
  immatureExposureCount: number;
}

interface ExposureRow {
  exposure_event_id: string;
  task_id: string;
  agent_id: string;
  run_id: string | null;
  occurred_at: Date;
  algorithm_version: string;
  /** `null` when the task had NOT yet reached a terminal status
   * (RELEASED/REFUNDED/CANCELLED) AS OF `asOf` — see this function's own
   * N4 real-finding writeup below for why this must come from
   * `task_state_history` filtered to `occurred_at <= asOf`, never from
   * `tasks.status`'s current value. */
  terminal_status_as_of: "RELEASED" | "REFUNDED" | "CANCELLED" | null;
  accepted_agent_id: string | null;
  score: string;
  rank: number;
  slot_type: string;
  semantic_similarity: number | null;
  reputation_signals: ReputationSignalsDigest | null;
}

/**
 * `asOf` (default: `new Date()`) is the one input that makes two calls
 * produce different results — passing the SAME `asOf` against the SAME
 * (unchanged) database state always produces the SAME output, which is
 * exactly what AC-1904's "数据集可复现构建" requires; the caller (the CLI
 * script) is responsible for recording it, not this function.
 *
 * N4 real finding (P1, round 1): the original version determined maturity
 * from `tasks.status`'s CURRENT value — a task that reached a terminal
 * status AFTER `asOf` would still be counted mature, and re-building the
 * "same" `asOf` snapshot later (after that task settled) would silently
 * change its own output, leaking future information into what's supposed
 * to be a frozen historical view (exactly F-1905's own named failure mode).
 * Fixed by looking up the LATEST `task_state_history` row transitioning
 * INTO a terminal status with `occurred_at <= asOf` (a `LEFT JOIN LATERAL`
 * per exposure) — a task is only "mature as of `asOf`" if that terminal
 * transition itself already happened by `asOf`, matching how a real
 * historical rebuild must behave. `accepted_agent_id` stays a plain read
 * of `tasks`' current value deliberately: `RELEASED`/`REFUNDED` can only be
 * reached from `ACCEPTED`, so once a terminal transition is confirmed
 * `<= asOf`, acceptance necessarily already happened by then too, and
 * `accepted_agent_id` never changes again after being set — no separate
 * "as of" lookup is needed for that one column.
 *
 * N4 real finding (P2, round 2 [T-1904]): ordering only by `ie.occurred_at`
 * isn't a total order — Postgres's `now()` is transaction-stable, so
 * multiple `EXPOSURE` rows relayed together (e.g. every candidate from one
 * `/match` call) can share the exact same timestamp, and Postgres is then
 * free to return those tied rows in any order on different executions,
 * breaking AC-1904's byte-identical-rebuild contract. `ie.id` (a real,
 * stable UUID) is the deterministic tiebreaker.
 */
export async function buildTrainingDataset(
  pool: Pool,
  options: { asOf?: Date; excludedRunIds?: string[] } = {},
): Promise<DatasetBuildResult> {
  const asOf = options.asOf ?? new Date();
  // F-1912/T-1908: the real "排除" half of "识别并排除明显的刷曝光/刷点击
  // 行为对训练数据...的污染". N4 real finding (P1, round 2 [T-1908]): a
  // real `EXPOSURE` row's `session_id` is always the server-synthesized
  // `server:<taskId>` (T-1901's own convention), never the client-supplied
  // session id `detectAnomalousSessions` flags from real `VIEW`/`CLICK`
  // events — filtering `EXPOSURE` rows by session id can therefore never
  // match a real flagged client, silently letting the exact pollution
  // F-1912 names straight through despite this code compiling and this
  // Task's own (flawed) first test passing (it only passed because the
  // test artificially assigned the SAME session id to both event types,
  // which real code never does). The real, existing correlation key
  // between a client's `VIEW`/`CLICK` and the `EXPOSURE` it reacted to is
  // `run_id` (T-1902's own attribution anchor redesign — a stranger cannot
  // forge another run's id). `excludedRunIds` is expected to come from
  // `fairness-monitor.ts`'s `detectAnomalousSessions` output resolved to
  // the run ids those flagged sessions' real events reference
  // (`build-ctr-training-dataset.ts` is the one real caller that performs
  // that resolution); an empty/omitted list excludes nothing, not an error.
  const excludedRunIds = options.excludedRunIds ?? [];

  const { rows } = await pool.query<ExposureRow>(
    `SELECT
       ie.id AS exposure_event_id,
       ie.task_id,
       ie.agent_id,
       ie.run_id,
       ie.occurred_at,
       rr.algorithm_version,
       term.to_status AS terminal_status_as_of,
       t.accepted_agent_id,
       rc.score,
       rc.rank,
       rc.slot_type,
       rc.semantic_similarity,
       rc.reputation_signals
     FROM interaction_events ie
     JOIN tasks t ON t.id = ie.task_id
     JOIN recommendation_runs rr ON rr.id = ie.run_id
     JOIN recommendation_candidates rc ON rc.run_id = ie.run_id AND rc.agent_id = ie.agent_id
     LEFT JOIN LATERAL (
       SELECT tsh.to_status
       FROM task_state_history tsh
       WHERE tsh.task_id = ie.task_id
         AND tsh.to_status IN ('RELEASED', 'REFUNDED', 'CANCELLED')
         AND tsh.occurred_at <= $1
       ORDER BY tsh.occurred_at DESC
       LIMIT 1
     ) term ON true
     WHERE ie.event_type = 'EXPOSURE'
       AND ie.occurred_at <= $1
       AND ie.task_id IS NOT NULL
       AND ie.agent_id IS NOT NULL
       AND ie.run_id IS NOT NULL
       AND ie.run_id <> ALL($2::uuid[])
     ORDER BY ie.occurred_at ASC, ie.id ASC`,
    [asOf.toISOString(), excludedRunIds],
  );

  const matureRows = rows.filter((row) => row.terminal_status_as_of !== null);
  const immatureExposureCount = rows.length - matureRows.length;
  const acceptedTaskIds = [
    ...new Set(
      matureRows.filter((row) => row.accepted_agent_id === row.agent_id).map((row) => row.task_id),
    ),
  ];

  // N4 real finding (P2, round 2 [T-1908]): the original version issued
  // one `findAttributedOutcomes` query (plus a conditional rating query)
  // PER accepted exposure — a real production snapshot with thousands of
  // accepted rows would serialize thousands of round trips. Fixed: fetch
  // every candidate outcome event for ALL relevant tasks in ONE query
  // (bounded to `asOf`, since this batched query has no single exposure's
  // own occurred_at to anchor a tighter per-row lower bound against —
  // `isAttributedEvent`'s own pure logic below still applies the REAL
  // per-exposure window/task/agent matching rules afterward, so this wider
  // net doesn't change which events end up attributed, it only avoids
  // re-querying once per row to get there), plus one batched rating
  // lookup, then reuse `isAttributedEvent` (already extracted as a pure
  // function for exactly this kind of in-memory reapplication) per
  // exposure instead of a second round trip.
  const candidateEventsByTask = await fetchCandidateEventsByTask(pool, acceptedTaskIds, asOf);
  const ratingScoreByTask = await fetchRatingScoresByTask(pool, acceptedTaskIds);

  const matureExamples: TrainingExampleRow[] = [];
  for (const row of matureRows) {
    if (!row.terminal_status_as_of) continue; // narrows the type; already filtered above

    const wasAccepted = row.accepted_agent_id === row.agent_id;
    let outcome: TrainingExampleOutcome | null = null;
    if (wasAccepted) {
      const exposure: AttributionCandidate = {
        eventType: "EXPOSURE",
        taskId: row.task_id,
        agentId: row.agent_id,
        runId: row.run_id,
        occurredAt: row.occurred_at,
      };
      const attributed = (candidateEventsByTask.get(row.task_id) ?? []).filter((candidate) =>
        isAttributedEvent(exposure, candidate, DEFAULT_ATTRIBUTION_WINDOW_MS),
      );
      const hasRateEvent = attributed.some((e) => e.eventType === "RATE");
      outcome = {
        approved: attributed.some((e) => e.eventType === "APPROVE"),
        ratingScore: hasRateEvent ? (ratingScoreByTask.get(row.task_id) ?? null) : null,
        refunded: attributed.some((e) => e.eventType === "REFUND"),
        disputed: attributed.some((e) => e.eventType === "DISPUTE"),
      };
    }

    matureExamples.push({
      exposureEventId: row.exposure_event_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      runId: row.run_id,
      algorithmVersion: row.algorithm_version,
      taskTerminalStatus: row.terminal_status_as_of,
      candidateFeatures: {
        score: Number(row.score),
        rank: row.rank,
        slotType: row.slot_type,
        reputationSignals: row.reputation_signals,
        semanticSimilarity: row.semantic_similarity,
      },
      wasAccepted,
      outcome,
    });
  }

  return { asOf, matureExamples, immatureExposureCount };
}

/**
 * Batches every non-`EXPOSURE` candidate event for the given task ids into
 * one query, grouped by task — the in-memory replacement for N calls to
 * `findAttributedOutcomes` (see `buildTrainingDataset`'s own N4 doc
 * comment). Bounded to `asOf` (never `undefined`), matching the same
 * "never leak a future event into a historical snapshot" rule the
 * per-exposure version enforced via `upperBound`.
 */
async function fetchCandidateEventsByTask(
  pool: Pool,
  taskIds: string[],
  asOf: Date,
): Promise<Map<string, AttributionCandidate[]>> {
  const byTask = new Map<string, AttributionCandidate[]>();
  if (taskIds.length === 0) return byTask;

  const { rows } = await pool.query<{
    event_type: string;
    task_id: string | null;
    agent_id: string | null;
    run_id: string | null;
    occurred_at: Date;
  }>(
    `SELECT event_type, task_id, agent_id, run_id, occurred_at
       FROM interaction_events
      WHERE task_id = ANY($1::uuid[])
        AND event_type <> 'EXPOSURE'
        AND occurred_at <= $2
      ORDER BY occurred_at ASC`,
    [taskIds, asOf.toISOString()],
  );

  for (const row of rows) {
    if (!row.task_id) continue;
    const candidate: AttributionCandidate = {
      eventType: row.event_type,
      taskId: row.task_id,
      agentId: row.agent_id,
      runId: row.run_id,
      occurredAt: row.occurred_at,
    };
    const group = byTask.get(row.task_id);
    if (group) group.push(candidate);
    else byTask.set(row.task_id, [candidate]);
  }
  return byTask;
}

/**
 * `interaction_events` doesn't duplicate business-table columns (CLAUDE.md
 * 原则 6, the real value lives in `ratings.score` alone) — batched the same
 * way as `fetchCandidateEventsByTask`. A settled task has at most one
 * rating (F-1005's own "once-per-task" rule), so a plain `task_id` key is
 * unambiguous.
 */
async function fetchRatingScoresByTask(
  pool: Pool,
  taskIds: string[],
): Promise<Map<string, number>> {
  const byTask = new Map<string, number>();
  if (taskIds.length === 0) return byTask;

  const { rows } = await pool.query<{ task_id: string; score: number }>(
    `SELECT task_id, score FROM ratings WHERE task_id = ANY($1::uuid[])`,
    [taskIds],
  );
  for (const row of rows) byTask.set(row.task_id, row.score);
  return byTask;
}
