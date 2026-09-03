import type { Queryable } from "../../db/pool.js";

export interface RatingRow {
  id: string;
  taskId: string;
  requesterAddress: string;
  score: number;
  communicationScore: number | null;
  createdAt: Date;
}

interface RatingQueryRow {
  id: string;
  task_id: string;
  requester_address: string;
  score: number;
  communication_score: number | null;
  created_at: Date;
}

function toRatingRow(row: RatingQueryRow): RatingRow {
  return {
    id: row.id,
    taskId: row.task_id,
    requesterAddress: row.requester_address,
    score: row.score,
    communicationScore: row.communication_score,
    createdAt: row.created_at,
  };
}

/** Same rationale as `disputes/repository.ts`'s own local copy — `pg`
 * reports a unique-constraint violation as SQLSTATE `23505`; this table's
 * one relevant unique constraint is `ratings.task_id` (a plain `UNIQUE`,
 * 0012_create_ratings.sql), so any `23505` here means the task already
 * has a rating. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface InsertRatingInput {
  taskId: string;
  requesterAddress: string;
  score: number;
  /** `undefined` (field omitted from the request) and `null` are treated
   * identically here — both mean "not submitted" — since schema.ts's
   * `communicationScore` is `.optional()`, never `.nullable()`; the SQL
   * parameter binds either as SQL `NULL`. */
  communicationScore?: number;
}

/** Returns `null` (not a thrown error) when the task already has a rating
 * — `ratings.task_id`'s uniqueness violation translated into a routine
 * "already rated" outcome the caller (`ratings/routes.ts`) turns into a
 * 409, matching `disputes/repository.ts`'s `insertDispute` and
 * `tasks/service.ts`'s `insertTaskDraft` established "constraint
 * violation is expected concurrency, not a crash" posture. */
export async function insertRating(
  pool: Queryable,
  input: InsertRatingInput,
): Promise<RatingRow | null> {
  try {
    const { rows } = await pool.query<RatingQueryRow>(
      `INSERT INTO ratings (task_id, requester_address, score, communication_score)
       VALUES ($1, $2, $3, $4)
       RETURNING id, task_id, requester_address, score, communication_score, created_at`,
      [input.taskId, input.requesterAddress, input.score, input.communicationScore ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error("insertRating: INSERT ... RETURNING produced no row");
    return toRatingRow(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * T-1006: `RatingSection` (frontend) needs to know whether the CURRENT
 * task already has a rating before deciding to render the submission form
 * or a read-only "已评分" display — `POST /tasks/:taskId/ratings`'s own
 * 409 response exists to reject a *duplicate submission attempt*, not to
 * serve as a query for "has this been rated yet?" (that would mean
 * blindly submitting a throwaway request just to read the error). A
 * rating's score is not sensitive the way dispute evidence is — it is
 * already folded into `agents.quality_score`, which `GET /agents/:agentId`
 * already exposes publicly — so this is a plain, ungated read, unlike
 * `disputes/repository.ts`'s `getDisputeForTask` which needs an access
 * guard.
 */
export async function getRatingForTask(pool: Queryable, taskId: string): Promise<RatingRow | null> {
  const { rows } = await pool.query<RatingQueryRow>(
    `SELECT id, task_id, requester_address, score, communication_score, created_at
     FROM ratings WHERE task_id = $1`,
    [taskId],
  );
  const row = rows[0];
  return row ? toRatingRow(row) : null;
}

/**
 * All real scores ever submitted for tasks the given Agent completed —
 * the ONLY input `ratings/service.ts`'s `aggregateQualityScore` is allowed
 * to read (requirements.md F-1006: "全部真实提交过的评分"). Joins through
 * `tasks.accepted_agent_id` rather than storing an `agent_id` column
 * directly on `ratings` — the requester rates a TASK, and which Agent that
 * task belongs to is `tasks`' own knowledge, not `ratings`' to duplicate.
 */
export async function getScoresForAgent(pool: Queryable, agentId: string): Promise<number[]> {
  const { rows } = await pool.query<{ score: number }>(
    `SELECT r.score FROM ratings r
     JOIN tasks t ON t.id = r.task_id
     WHERE t.accepted_agent_id = $1`,
    [agentId],
  );
  return rows.map((row) => row.score);
}
