import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";

export type DeliverableStorageType = "LOCAL_FILE" | "URL";

export interface DeliverableRow {
  id: string;
  taskId: string;
  agentAddress: string;
  storageType: DeliverableStorageType;
  filePath: string | null;
  resultUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  resultHash: string;
  createdAt: Date;
}

interface DeliverableQueryRow {
  id: string;
  task_id: string;
  agent_address: string;
  storage_type: DeliverableStorageType;
  file_path: string | null;
  result_url: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  result_hash: string;
  created_at: Date;
}

function toDeliverableRow(row: DeliverableQueryRow): DeliverableRow {
  return {
    id: row.id,
    taskId: row.task_id,
    agentAddress: row.agent_address,
    storageType: row.storage_type,
    filePath: row.file_path,
    resultUrl: row.result_url,
    mimeType: row.mime_type,
    // BIGINT comes back from `pg` as a string to avoid silent precision
    // loss above 2^53 — this column's own CHECK only ever allows a value
    // MAX_FILE_SIZE_BYTES (20 MiB) can represent, so converting to a JS
    // number here is safe, matching how other small BIGINT-ish counters
    // are already handled elsewhere in this codebase (e.g. total counts).
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    resultHash: row.result_hash,
    createdAt: row.created_at,
  };
}

export interface InsertDeliverableInput {
  taskId: string;
  agentAddress: string;
  storageType: DeliverableStorageType;
  filePath: string | null;
  resultUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  resultHash: string;
}

/**
 * One row per submission attempt (0009_create_deliverables.sql's own
 * header comment) — never an UPDATE-in-place, so a resubmission keeps the
 * prior attempt's audit trail. The `deliverables_payload_matches_storage_type`/
 * `deliverables_result_url_is_https`/`result_hash` format CHECKs are the
 * actual enforcement; this function trusts its caller (routes.ts, already
 * validated by schema.ts/storage.local.ts) rather than re-validating here.
 */
export async function insertDeliverable(
  client: Queryable,
  input: InsertDeliverableInput,
): Promise<DeliverableRow> {
  const { rows } = await client.query<DeliverableQueryRow>(
    `INSERT INTO deliverables (task_id, agent_address, storage_type, file_path, result_url, mime_type, size_bytes, result_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, task_id, agent_address, storage_type, file_path, result_url, mime_type, size_bytes, result_hash, created_at`,
    [
      input.taskId,
      input.agentAddress,
      input.storageType,
      input.filePath,
      input.resultUrl,
      input.mimeType,
      input.sizeBytes,
      input.resultHash,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("insertDeliverable: INSERT ... RETURNING produced no row");
  }
  return toDeliverableRow(row);
}

/**
 * T-904: the most recent submission attempt for a task (0009_create_deliverables.sql's
 * own header comment — one row per attempt, never updated in place), by
 * `sequence_no DESC` matching `deliverables_task_id_sequence_no_idx`'s own
 * column order. `sequence_no` (a `BIGSERIAL`), not `created_at`, is the
 * deterministic ordering key (N4 round 1 P2, Codex): two submissions
 * landing in the same DB-clock instant would otherwise make
 * `ORDER BY created_at DESC` pick either row nondeterministically — same
 * reasoning as `dispatch/repository.ts`'s `recommendation_runs.sequence_no`
 * ordering. `null` when the task has never had a deliverable submitted —
 * the caller (`routes.ts`) turns that into a 404, not an error.
 */
export async function getLatestDeliverableForTask(
  client: Queryable,
  taskId: string,
): Promise<DeliverableRow | null> {
  const { rows } = await client.query<DeliverableQueryRow>(
    `SELECT id, task_id, agent_address, storage_type, file_path, result_url, mime_type, size_bytes, result_hash, created_at
     FROM deliverables
     WHERE task_id = $1
     ORDER BY sequence_no DESC
     LIMIT 1`,
    [taskId],
  );
  const row = rows[0];
  return row ? toDeliverableRow(row) : null;
}

/**
 * F-906: only the task's own accepted Agent, only while the task is
 * ACCEPTED, only before deliveryDeadline. Single implementation — both
 * `routes.ts`'s fast pre-upload rejection (using whatever `TaskRow` it
 * already fetched, for a quick 409 before wasting effort on a file
 * upload) and `insertDeliverableIfSubmissionAllowed` below's row-locked
 * recheck (the actual authoritative gate) call this exact function,
 * rather than each re-deriving the rule (CLAUDE.md 原则 6).
 */
export function checkSubmissionAllowed(
  task: { status: string; acceptedAgentAddress: string | null; deliveryDeadline: Date },
  sessionAddress: string,
): string | undefined {
  if (task.status !== "ACCEPTED") {
    return "任务当前状态不允许提交成果。";
  }
  if (
    !task.acceptedAgentAddress ||
    task.acceptedAgentAddress.toLowerCase() !== sessionAddress.toLowerCase()
  ) {
    return "只有本任务的接单 Agent 才能提交成果。";
  }
  if (task.deliveryDeadline.getTime() <= Date.now()) {
    return "已超过截止时间，无法提交成果。";
  }
  return undefined;
}

export class DeliverableSubmissionNotAllowedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "DeliverableSubmissionNotAllowedError";
  }
}

interface TaskGateRow {
  status: string;
  accepted_agent_address: string | null;
  delivery_deadline: Date;
}

/**
 * N4 round 2 P1 fix (Codex): `routes.ts`'s earlier version validated F-906
 * once against a `getTaskById` read taken BEFORE the (potentially slow —
 * file buffering + disk write) upload work, then inserted unconditionally.
 * A task that left ACCEPTED, got reassigned, or crossed its
 * deliveryDeadline during that window would still get a deliverable
 * persisted. This function closes that TOCTOU gap the same way
 * `dispatch/repository.ts`'s `insertRecommendationRunWithPermits` closes
 * its own analogous one (T-806): `SELECT ... FOR UPDATE` locks the task
 * row, `checkSubmissionAllowed` re-runs against that FRESH, lock-held
 * read, and only then does the INSERT happen — all inside one
 * transaction, so no other writer can change the task's
 * status/accepted_agent_address/delivery_deadline between the recheck and
 * the insert.
 */
export async function insertDeliverableIfSubmissionAllowed(
  pool: Pool,
  input: InsertDeliverableInput,
  sessionAddress: string,
): Promise<DeliverableRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<TaskGateRow>(
      `SELECT status, accepted_agent_address, delivery_deadline FROM tasks WHERE id = $1 FOR UPDATE`,
      [input.taskId],
    );
    const taskRow = rows[0];
    if (!taskRow) {
      throw new DeliverableSubmissionNotAllowedError("任务不存在。");
    }
    const denialReason = checkSubmissionAllowed(
      {
        status: taskRow.status,
        acceptedAgentAddress: taskRow.accepted_agent_address,
        deliveryDeadline: taskRow.delivery_deadline,
      },
      sessionAddress,
    );
    if (denialReason) {
      throw new DeliverableSubmissionNotAllowedError(denialReason);
    }

    const inserted = await insertDeliverable(client, input);
    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
