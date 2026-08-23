import type { Pool, PoolClient } from "pg";
import type { Queryable } from "../../db/pool.js";
import { countActiveTasksByAgentIds } from "../tasks/repository.js";

/**
 * Wire-format candidate snapshot POST /match (services/dispatch, T-704)
 * expects on its `candidates[]` array — field names match `matchCandidate`
 * (services/dispatch/internal/httpapi/match.go) exactly. `isNewcomer` is
 * deliberately absent: T-704's Go service computes newcomer status itself
 * from `completedTaskCount` (`domain.IsNewcomer`) and does not accept it as
 * an external input (capsule: "不要发送 isNewcomer 字段").
 */
export interface CandidateSnapshot {
  agentId: string;
  walletAddress: string;
  status: string;
  category: string;
  skillTags: string[];
  level: string;
  maxConcurrentTasks: number;
  activeTaskCount: number;
  completedTaskCount: number;
  successCount: number;
  overdueCount: number;
  qualityScore: number | null;
  createdAt: string;
  isBanned: boolean;
}

interface CandidateAgentRow {
  id: string;
  owner_address: string;
  status: string;
  category: string;
  level: string;
  max_concurrent_tasks: number;
  completed_task_count: number;
  success_count: number;
  overdue_count: number;
  quality_score: number | null;
  created_at: Date;
}

/**
 * T-705: assembles every `ACTIVE` Agent into the `CandidateSnapshot[]` the
 * Go dispatch service's `POST /match` consumes.
 *
 * The `status = 'ACTIVE'` filter below is a read optimization, not a
 * reimplementation of eligibility: `eligibility.Filter` (Go,
 * services/dispatch/internal/eligibility) independently checks the exact
 * same `status` field's exact same value again. Two checks of the same
 * real-world fact aren't two competing rules — one is "skip rows that can
 * never pass" (here), the other is the actual authority (Go). See the
 * T-705 capsule's reasoning for why this is the one narrow exception to
 * "eligibility logic lives only in Go."
 *
 * Deliberately does NOT filter by `taskCategory` — category-compatibility
 * matching is eligibility's job alone (T-701 already fixed this as an exact
 * match rule); this function only fetches raw data and hands it over.
 */
export async function assembleCandidateSnapshots(
  client: Queryable,
  taskCategory: string,
): Promise<CandidateSnapshot[]> {
  // `taskCategory` is part of this function's fixed interface (T-705
  // capsule) but deliberately unused in the query below — see this
  // function's own doc comment for why category-compatibility filtering
  // must stay eligibility's (Go) job alone.
  void taskCategory;

  const { rows: agentRows } = await client.query<CandidateAgentRow>(
    `SELECT id, owner_address, status, category, level, max_concurrent_tasks,
            completed_task_count, success_count, overdue_count, quality_score, created_at
     FROM agents
     WHERE status = 'ACTIVE'`,
  );

  if (agentRows.length === 0) {
    return [];
  }

  const agentIds = agentRows.map((row) => row.id);

  const { rows: skillRows } = await client.query<{ agent_id: string; skill_tag: string }>(
    `SELECT agent_id, skill_tag FROM agent_skills WHERE agent_id = ANY($1)`,
    [agentIds],
  );
  const skillTagsByAgentId = new Map<string, string[]>();
  for (const row of skillRows) {
    const existing = skillTagsByAgentId.get(row.agent_id);
    if (existing) {
      existing.push(row.skill_tag);
    } else {
      skillTagsByAgentId.set(row.agent_id, [row.skill_tag]);
    }
  }

  // Batched: one query for every candidate's occupancy, not one query per
  // candidate — this function's own contract, mirrored by the batched
  // blocked_wallets lookup below.
  const activeTaskCountByAgentId = await countActiveTasksByAgentIds(client, agentIds);

  const walletAddresses = agentRows.map((row) => row.owner_address);
  const { rows: bannedRows } = await client.query<{ address: string }>(
    `SELECT address FROM blocked_wallets WHERE address = ANY($1)`,
    [walletAddresses],
  );
  const bannedWallets = new Set(bannedRows.map((row) => row.address));

  return agentRows.map((row) => ({
    agentId: row.id,
    walletAddress: row.owner_address,
    status: row.status,
    category: row.category,
    skillTags: skillTagsByAgentId.get(row.id) ?? [],
    level: row.level,
    maxConcurrentTasks: row.max_concurrent_tasks,
    activeTaskCount: activeTaskCountByAgentId.get(row.id) ?? 0,
    completedTaskCount: row.completed_task_count,
    successCount: row.success_count,
    overdueCount: row.overdue_count,
    qualityScore: row.quality_score,
    createdAt: row.created_at.toISOString(),
    isBanned: bannedWallets.has(row.owner_address),
  }));
}

/**
 * T-705: reads back just `tasks.required_agent_level` for `taskId`. A
 * dedicated one-column query rather than extending `tasks/repository.ts`'s
 * `TaskRow`/`getTaskById` (routes.ts already calls `getTaskById` for the
 * 404/ownership check and every other field `POST /match`'s request needs) —
 * broadening that shared type for this one dispatch-only field would ripple
 * into every other caller of `TaskRow` across the codebase for a value only
 * this route needs. Returns `null` only if `taskId` doesn't exist (routes.ts
 * never actually reaches this branch in practice, since it already confirmed
 * the task exists via `getTaskById` first).
 */
export async function getRequiredAgentLevel(
  client: Queryable,
  taskId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ required_agent_level: string }>(
    `SELECT required_agent_level FROM tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0]?.required_agent_level ?? null;
}

/** One recommended slot, as returned by the Go dispatch service and about
 * to be persisted. */
export interface RecommendationCandidateInput {
  agentId: string;
  rank: number;
  slotType: string;
  score: number;
  reasons: string[];
}

export interface InsertRecommendationRunInput {
  taskId: string;
  algorithmVersion: string;
  /** The full candidate pool sent to the Go service — NOT the number of
   * recommendations it returned (T-705 capsule: "candidate_count 用发给 Go 的
   *候选总数，不是返回的推荐数"). */
  candidateCount: number;
  candidates: RecommendationCandidateInput[];
}

/**
 * Persists one `POST /tasks/:taskId/match` run: the `recommendation_runs`
 * row plus one `recommendation_candidates` row per recommended slot, in a
 * single transaction — a partial write (run recorded, some candidate rows
 * missing) would silently corrupt "this run recommended exactly these
 * slots" as a single unit, mirroring tasks/repository.ts's `insertTaskDraft`.
 */
export async function insertRecommendationRun(
  pool: Pool,
  input: InsertRecommendationRunInput,
): Promise<{ runId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.taskId, input.algorithmVersion, input.candidateCount],
    );
    const runId = rows[0]?.id;
    if (!runId) {
      throw new Error("insertRecommendationRun: INSERT ... RETURNING produced no row");
    }

    for (const candidate of input.candidates) {
      await insertRecommendationCandidate(client, runId, candidate);
    }

    await client.query("COMMIT");
    return { runId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * One recommended candidate as read back from the most recent
 * `recommendation_run` for a task — the shape both
 * `GET /tasks/:taskId/recommendations` and
 * `POST /tasks/:taskId/acceptance-permits` (T-706) consume from the single
 * query below. `agentWalletAddress` is included here (joined from
 * `agents.owner_address`) even though the `GET /recommendations` response
 * shape (design.md) doesn't expose it — routes.ts drops it for that route
 * and uses it for the acceptance-permits route, which needs the candidate's
 * wallet address to sign the `AcceptancePermit.agent` field.
 */
export interface LatestRecommendationCandidate {
  agentId: string;
  agentWalletAddress: string;
  rank: number;
  slotType: string;
  score: number;
  reasons: string[];
}

/**
 * Reads back the most recent `recommendation_run`'s candidates for
 * `taskId`, ordered by rank ascending (T-706 capsule: "查询最新一次
 * recommendation_run 的候选列表"). Both T-706 routes need exactly this — "the
 * latest run's full candidate list" — so it's the one query both call
 * rather than each assembling its own join.
 *
 * Returns `[]` when no run exists yet for this task (nobody has called
 * `POST /tasks/:taskId/match`) — a legitimate state (F-709), not an error;
 * callers decide what that means for their own response (200 empty array
 * for GET /recommendations, 400 for POST /acceptance-permits).
 *
 * The subquery scopes directly to `run_id = (... ORDER BY requested_at DESC,
 * sequence_no DESC LIMIT 1)` rather than a `MAX(requested_at)` aggregate —
 * one round trip. `sequence_no` (a `BIGSERIAL`) is the deterministic
 * tiebreaker: `requested_at` alone can tie when two `POST /match` calls for
 * the same task land in the same DB-clock instant, which would otherwise
 * make "the latest run" pick either row nondeterministically (Codex review,
 * T-706 round 1, P2).
 *
 * `rc.score` is `NUMERIC` in Postgres, which `pg` returns as a string (no
 * custom type parser is registered in this codebase) — explicitly
 * `Number(...)`-converted here, the same pattern `agents/repository.ts`
 * uses for its own `NUMERIC`-derived aggregate.
 */
export async function getLatestRecommendationCandidates(
  client: Queryable,
  taskId: string,
): Promise<LatestRecommendationCandidate[]> {
  const { rows } = await client.query<{
    agent_id: string;
    owner_address: string;
    rank: number;
    slot_type: string;
    score: string;
    reasons: string[];
  }>(
    `SELECT rc.agent_id, a.owner_address, rc.rank, rc.slot_type, rc.score, rc.reasons
     FROM recommendation_candidates rc
     JOIN agents a ON a.id = rc.agent_id
     WHERE rc.run_id = (
       SELECT id FROM recommendation_runs
       WHERE task_id = $1
       ORDER BY requested_at DESC, sequence_no DESC
       LIMIT 1
     )
     ORDER BY rc.rank ASC`,
    [taskId],
  );

  return rows.map((row) => ({
    agentId: row.agent_id,
    agentWalletAddress: row.owner_address,
    rank: row.rank,
    slotType: row.slot_type,
    score: Number(row.score),
    reasons: row.reasons,
  }));
}

async function insertRecommendationCandidate(
  client: PoolClient,
  runId: string,
  candidate: RecommendationCandidateInput,
): Promise<void> {
  await client.query(
    `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      candidate.agentId,
      candidate.rank,
      candidate.slotType,
      candidate.score,
      JSON.stringify(candidate.reasons),
    ],
  );
}
