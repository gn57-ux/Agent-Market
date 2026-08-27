import type { Queryable } from "../../db/pool.js";

export interface DisputeRow {
  id: string;
  taskId: string;
  requesterAddress: string;
  reason: string;
  evidenceSummary: string;
  evidenceHash: `0x${string}`;
  status: "OPEN" | "RESOLVED";
  resolution: "SUPPORT_AGENT" | "SUPPORT_REQUESTER" | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

interface DisputeQueryRow {
  id: string;
  task_id: string;
  requester_address: string;
  reason: string;
  evidence_summary: string;
  evidence_hash: string;
  status: "OPEN" | "RESOLVED";
  resolution: "SUPPORT_AGENT" | "SUPPORT_REQUESTER" | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

function toDisputeRow(row: DisputeQueryRow): DisputeRow {
  return {
    id: row.id,
    taskId: row.task_id,
    requesterAddress: row.requester_address,
    reason: row.reason,
    evidenceSummary: row.evidence_summary,
    evidenceHash: row.evidence_hash as `0x${string}`,
    status: row.status,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

const DISPUTE_COLUMNS = `id, task_id, requester_address, reason, evidence_summary, evidence_hash,
                         status, resolution, resolved_by, resolved_at, created_at`;

/** `pg` reports a unique-constraint violation as SQLSTATE `23505` — same
 * check `tasks/service.ts`'s own `isUniqueViolation` uses, re-declared
 * here rather than imported (that function isn't exported, and this is a
 * two-line, well-understood check, not business knowledge worth coupling
 * two otherwise-independent modules over). This table's one relevant
 * unique constraint is `disputes_task_id_unique_open`
 * (0011_create_disputes.sql, a partial index on `task_id WHERE status =
 * 'OPEN'`), so any `23505` from `insertDispute` below is that constraint —
 * a second dispute submission for a task that already has an open one. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface InsertDisputeInput {
  taskId: string;
  requesterAddress: string;
  reason: string;
  evidenceSummary: string;
  evidenceHash: `0x${string}`;
}

/** Returns `null` (not a thrown error) when a dispute is already open for
 * this task — `disputes_task_id_unique_open`'s own uniqueness violation,
 * translated into a routine "already open" outcome the caller
 * (`disputes/routes.ts`) turns into a 409, matching this codebase's
 * established "constraint violation is expected concurrency, not a crash"
 * posture (`tasks/service.ts`'s `insertTaskDraft`). */
export async function insertDispute(
  pool: Queryable,
  input: InsertDisputeInput,
): Promise<DisputeRow | null> {
  try {
    const { rows } = await pool.query<DisputeQueryRow>(
      `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${DISPUTE_COLUMNS}`,
      [
        input.taskId,
        input.requesterAddress,
        input.reason,
        input.evidenceSummary,
        input.evidenceHash,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("insertDispute: INSERT ... RETURNING produced no row");
    return toDisputeRow(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

/** The current dispute for a task — `OPEN` if one is active, otherwise the
 * most recently created row regardless of status (there is at most one
 * dispute per task in this Feature's one-shot arbitration model, so
 * "latest" and "the" dispute coincide once resolved). */
export async function getDisputeForTask(
  pool: Queryable,
  taskId: string,
): Promise<DisputeRow | null> {
  const { rows } = await pool.query<DisputeQueryRow>(
    `SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  const row = rows[0];
  return row ? toDisputeRow(row) : null;
}

export async function getOpenDisputeForTask(
  pool: Queryable,
  taskId: string,
): Promise<DisputeRow | null> {
  const { rows } = await pool.query<DisputeQueryRow>(
    `SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE task_id = $1 AND status = 'OPEN'`,
    [taskId],
  );
  const row = rows[0];
  return row ? toDisputeRow(row) : null;
}

/**
 * Resolves the task's currently-`OPEN` dispute — called from inside
 * `verifyDisputeResolution`'s (tasks/service.ts) `transitionTaskStatus`
 * transaction, alongside the `tasks` status UPDATE and
 * `settlement-stats.ts` write, so "the dispute row says RESOLVED" and "the
 * task moved to RELEASED/REFUNDED" can never be observably out of sync.
 * Returns `false` (not a thrown error — this function has no transaction
 * boundary of its own to unwind, that is the caller's job) if there was no
 * `OPEN` dispute row to resolve. The caller MUST NOT treat that as a
 * routine no-op: `verifyDisputeResolution` already handles legitimate
 * idempotent replay (an already-RELEASED/REFUNDED task with a matching
 * recorded transaction) entirely BEFORE this transaction ever opens, so a
 * `false` reaching here means `tasks.status` says DISPUTED while the
 * `disputes` row disagrees — a genuine data inconsistency the caller must
 * roll back on, not silently commit past.
 */
export async function resolveDispute(
  pool: Queryable,
  taskId: string,
  resolution: "SUPPORT_AGENT" | "SUPPORT_REQUESTER",
  resolvedBy: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE disputes
     SET status = 'RESOLVED', resolution = $2, resolved_by = $3, resolved_at = now()
     WHERE task_id = $1 AND status = 'OPEN'`,
    [taskId, resolution, resolvedBy],
  );
  return (rowCount ?? 0) > 0;
}

export interface InsertAuditLogInput {
  actorAddress: string;
  action: string;
  taskId: string | null;
  reason: string | null;
  txHash: string | null;
}

/** PRD §15.1's arbitration/admin-action audit trail (0011_create_disputes.sql's
 * `audit_logs`) — a plain insert, no return value needed by any current
 * caller. */
export async function insertAuditLog(pool: Queryable, input: InsertAuditLogInput): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (actor_address, action, task_id, reason, tx_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.actorAddress, input.action, input.taskId, input.reason, input.txHash],
  );
}
