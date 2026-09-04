import type { Pool, PoolClient } from "pg";
import type { Queryable } from "../../db/pool.js";

export type TaskStatusValue =
  | "DRAFT"
  | "AWAITING_FUNDING"
  | "OPEN"
  | "ACCEPTED"
  | "SUBMITTED"
  | "DISPUTED"
  | "RELEASED"
  | "REFUNDED"
  | "CANCELLED";

export interface TaskRow {
  id: string;
  requesterAddress: string;
  category: string;
  title: string;
  description: string;
  /** Decimal text, never a JS `number` — see schema.ts's BUDGET_SCHEMA doc
   * comment for why: a NUMERIC column round-trips losslessly only if this
   * stays a string end-to-end. */
  budget: string;
  token: string;
  deliveryDeadline: Date;
  status: TaskStatusValue;
  fundingTxHash: string | null;
  idempotencyKey: string | null;
  skillTags: string[];
  createdAt: Date;
  updatedAt: Date;
  /** T-805: `tasks.accepted_agent_address`/`accepted_at` (0006_add_dispatch_
   * matching_fields.sql) — written atomically with the OPEN→ACCEPTED
   * transition (T-801/service.ts) but not previously read back by this
   * module. Both `null` until a task is accepted. */
  acceptedAgentAddress: string | null;
  acceptedAt: Date | null;
  /** T-1001: `tasks.accepted_agent_id` (0006_add_dispatch_matching_fields.sql)
   * — was already written atomically with `acceptedAgentAddress` at
   * accept time, but never read back by this module until now. Settlement
   * stats (`settlement-stats.ts`) must credit the specific `Agent` record
   * that accepted this task, not just its wallet address — a single
   * wallet can own more than one `Agent` (`AcceptanceSection.tsx`'s T-807
   * fix documents this exact case), so `acceptedAgentAddress` alone cannot
   * disambiguate which one to credit. */
  acceptedAgentId: string | null;
  /** T-904: `tasks.submitted_at`/`review_deadline` (0009_create_deliverables.sql,
   * Feature 9) — written verbatim from the on-chain `ResultSubmitted`
   * event's own fields by T-905's event-sync handler (not yet
   * implemented as of T-904; both stay `null` until then). Read back here
   * so `GET /tasks/:taskId/deliverables/latest` (deliverables/routes.ts)
   * can include them without a second query — this module still owns the
   * one column list every `tasks` read goes through. */
  submittedAt: Date | null;
  reviewDeadline: Date | null;
  /** Feature 12 (F-1205): `tasks.expert_type` (0013_add_agent_task_
   * credentials.sql) — a distinct axis from `category`/`skillTags`, see
   * that migration's own doc comment for why the column still carries a
   * DB-level DEFAULT despite this being a required API field. */
  expertType: string;
}

interface TaskQueryRow {
  id: string;
  requester_address: string;
  category: string;
  title: string;
  description: string;
  budget: string;
  token: string;
  delivery_deadline: Date;
  status: TaskStatusValue;
  funding_tx_hash: string | null;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
  accepted_agent_address: string | null;
  accepted_agent_id: string | null;
  accepted_at: Date | null;
  submitted_at: Date | null;
  review_deadline: Date | null;
  expert_type: string;
}

function toTaskRow(row: TaskQueryRow, skillTags: string[]): TaskRow {
  return {
    id: row.id,
    requesterAddress: row.requester_address,
    category: row.category,
    title: row.title,
    description: row.description,
    budget: row.budget,
    token: row.token,
    deliveryDeadline: row.delivery_deadline,
    status: row.status,
    fundingTxHash: row.funding_tx_hash,
    idempotencyKey: row.idempotency_key,
    skillTags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAgentAddress: row.accepted_agent_address,
    acceptedAgentId: row.accepted_agent_id,
    acceptedAt: row.accepted_at,
    submittedAt: row.submitted_at,
    reviewDeadline: row.review_deadline,
    expertType: row.expert_type,
  };
}

const TASK_COLUMNS = `id, requester_address, category, title, description, budget, token,
                      delivery_deadline, status, funding_tx_hash, idempotency_key,
                      created_at, updated_at, accepted_agent_address, accepted_agent_id, accepted_at,
                      submitted_at, review_deadline, expert_type`;

export interface InsertTaskDraftInput {
  requesterAddress: string;
  category: string;
  title: string;
  description: string;
  /** Decimal text — see TaskRow's `budget` field doc comment. */
  budget: string;
  token: string;
  deliveryDeadline: Date;
  idempotencyKey: string | null;
  skillTags: string[];
  /** Feature 12 (F-1205): required at the API boundary (schema.ts's
   * `createDraftSchema`) even though this column still carries a DB
   * DEFAULT — see TaskRow's own doc comment. */
  expertType: string;
}

/**
 * Inserts a `tasks` row (`status = 'DRAFT'`, F-601) plus its `task_skills`
 * rows in one transaction — a partial insert (task created, some skill tags
 * missing) would silently corrupt "任务草稿 + 技能标签" as a single unit,
 * mirroring agents/repository.ts's `insertAgent`.
 *
 * Callers (service.ts) are responsible for catching the unique-constraint
 * violation this throws when `(requester_address, idempotency_key)` already
 * exists (a concurrent duplicate submission) — this function itself makes no
 * attempt to swallow or pre-check that, so the DB-level constraint stays the
 * single source of truth for the conflict rather than a racy
 * check-then-insert in application code.
 */
export async function insertTaskDraft(pool: Pool, input: InsertTaskDraftInput): Promise<TaskRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<TaskQueryRow>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token,
          delivery_deadline, status, idempotency_key, expert_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9)
       RETURNING ${TASK_COLUMNS}`,
      [
        input.requesterAddress,
        input.category,
        input.title,
        input.description,
        input.budget,
        input.token,
        input.deliveryDeadline,
        input.idempotencyKey,
        input.expertType,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("insertTaskDraft: INSERT ... RETURNING produced no row");
    }

    for (const skillTag of input.skillTags) {
      await client.query(`INSERT INTO task_skills (task_id, skill_tag) VALUES ($1, $2)`, [
        row.id,
        skillTag,
      ]);
    }

    await client.query("COMMIT");
    return toTaskRow(row, input.skillTags);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadSkillTags(pool: Queryable, taskId: string): Promise<string[]> {
  const { rows } = await pool.query<{ skill_tag: string }>(
    `SELECT skill_tag FROM task_skills WHERE task_id = $1 ORDER BY skill_tag`,
    [taskId],
  );
  return rows.map((row) => row.skill_tag);
}

/** F-601/F-602: single task lookup by primary key, `null` if no such id
 * exists. */
export async function getTaskById(pool: Queryable, taskId: string): Promise<TaskRow | null> {
  const { rows } = await pool.query<TaskQueryRow>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`,
    [taskId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return toTaskRow(row, await loadSkillTags(pool, taskId));
}

/**
 * F-601's idempotency lookup: finds an existing task created by the same
 * requester with the same client-supplied `Idempotency-Key`. Scoped to
 * `requesterAddress` — matching the `(requester_address, idempotency_key)`
 * UNIQUE constraint (0005_create_tasks.sql) — so this is the exact query
 * service.ts's idempotent-create path (both the pre-check and the
 * post-conflict re-fetch) runs against.
 */
export async function findDraftByIdempotencyKey(
  pool: Queryable,
  requesterAddress: string,
  idempotencyKey: string,
): Promise<TaskRow | null> {
  const { rows } = await pool.query<TaskQueryRow>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE requester_address = $1 AND idempotency_key = $2`,
    [requesterAddress, idempotencyKey],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return toTaskRow(row, await loadSkillTags(pool, row.id));
}

export interface UpdateTaskDraftInput {
  category?: string;
  title?: string;
  description?: string;
  /** Decimal text — see TaskRow's `budget` field doc comment. */
  budget?: string;
  deliveryDeadline?: Date;
  skillTags?: string[];
  expertType?: string;
}

/**
 * F-602: partial update, restricted to rows currently `status = 'DRAFT'`
 * (the `WHERE` clause's `AND status = 'DRAFT'` — enforced here, at the same
 * layer that owns the SQL, rather than a separate read-then-write race in
 * service.ts). Returns a discriminated result so service.ts/routes.ts can
 * tell "no such task" apart from "task exists but isn't a draft anymore"
 * without a second round-trip.
 *
 * Only keys actually present in `patch` are touched, mirroring agents/
 * repository.ts's `updateAgent` — `Partial<CreateDraftInput>` means "change
 * these fields," not "reset everything with omitted ones cleared."
 * `skillTags`, when provided, replaces the full set (delete-then-reinsert in
 * the same transaction as the column update).
 */
export async function updateTaskDraft(
  pool: Pool,
  taskId: string,
  patch: UpdateTaskDraftInput,
): Promise<
  { outcome: "updated"; task: TaskRow } | { outcome: "not_found" } | { outcome: "not_draft" }
> {
  const client = await pool.connect();
  let outcome: "updated" | "not_found" | "not_draft";
  try {
    await client.query("BEGIN");

    const statusCheck = await client.query<{ status: TaskStatusValue }>(
      `SELECT status FROM tasks WHERE id = $1 FOR UPDATE`,
      [taskId],
    );
    const currentStatus = statusCheck.rows[0]?.status;
    if (!currentStatus) {
      outcome = "not_found";
    } else if (currentStatus !== "DRAFT") {
      outcome = "not_draft";
    } else {
      const fieldMap: Record<string, unknown> = {
        category: patch.category,
        title: patch.title,
        description: patch.description,
        budget: patch.budget,
        delivery_deadline: patch.deliveryDeadline,
        expert_type: patch.expertType,
      };
      const entries = Object.entries(fieldMap).filter(([, value]) => value !== undefined);

      if (entries.length > 0) {
        const setClauses = entries.map(([column], index) => `${column} = $${index + 2}`);
        const values = entries.map(([, value]) => value);
        await client.query(
          `UPDATE tasks SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1`,
          [taskId, ...values],
        );
      } else {
        // No plain-column changes requested (e.g. only skillTags changing)
        // — still touch updated_at so a skills-only edit is reflected in
        // the timestamp, matching what a full-row update would do.
        await client.query(`UPDATE tasks SET updated_at = now() WHERE id = $1`, [taskId]);
      }

      if (patch.skillTags !== undefined) {
        await client.query(`DELETE FROM task_skills WHERE task_id = $1`, [taskId]);
        for (const skillTag of patch.skillTags) {
          await client.query(`INSERT INTO task_skills (task_id, skill_tag) VALUES ($1, $2)`, [
            taskId,
            skillTag,
          ]);
        }
      }
      outcome = "updated";
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (outcome === "not_found" || outcome === "not_draft") {
    return { outcome };
  }
  const task = await getTaskById(pool, taskId);
  if (!task) {
    // Defensive: the row existed inside the transaction above but is gone
    // by the time we re-read it outside — no delete endpoint exists yet, so
    // this branch is not expected to be reachable in practice.
    return { outcome: "not_found" };
  }
  return { outcome: "updated", task };
}

// ---------------------------------------------------------------------
// T-604: DRAFT → AWAITING_FUNDING → OPEN transitions + the chain_transactions
// / chain_events rows a successful funding confirmation writes alongside
// the OPEN transition.
// ---------------------------------------------------------------------

type LockOutcome =
  | { outcome: "ok"; currentStatus: TaskStatusValue }
  | { outcome: "not_found" }
  | { outcome: "conflict"; currentStatus: TaskStatusValue };

/**
 * Locks a `tasks` row (`SELECT ... FOR UPDATE`) and checks its current
 * status is one of `allowedFromStatuses` — the same "lock, then check
 * before writing" pattern `updateTaskDraft` above already established, so
 * the two transitions T-604 adds (DRAFT→AWAITING_FUNDING,
 * AWAITING_FUNDING→OPEN) share this one row-locking/validation step rather
 * than each re-deriving it. Must only ever be called with an already-open
 * transaction's `client` — it does not manage BEGIN/COMMIT itself.
 */
async function lockTaskForTransition(
  client: PoolClient,
  taskId: string,
  allowedFromStatuses: readonly TaskStatusValue[],
): Promise<LockOutcome> {
  const { rows } = await client.query<{ status: TaskStatusValue }>(
    `SELECT status FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  const currentStatus = rows[0]?.status;
  if (!currentStatus) {
    return { outcome: "not_found" };
  }
  if (!allowedFromStatuses.includes(currentStatus)) {
    return { outcome: "conflict", currentStatus };
  }
  return { outcome: "ok", currentStatus };
}

async function insertStateHistory(
  client: PoolClient,
  taskId: string,
  fromStatus: TaskStatusValue,
  toStatus: TaskStatusValue,
  actor: string,
  reason: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO task_state_history (task_id, from_status, to_status, actor, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [taskId, fromStatus, toStatus, actor, reason],
  );
}

export type TaskTransitionResult =
  | { outcome: "transitioned"; task: TaskRow }
  | { outcome: "not_found" }
  | { outcome: "conflict"; currentStatus: TaskStatusValue }
  | { outcome: "precondition_failed"; reason: string };

export interface TransitionTaskStatusInput {
  taskId: string;
  /** Statuses the row is allowed to be transitioning *from*. Anything else
   * (including the target status itself, for a non-idempotent caller) is a
   * `conflict`. */
  allowedFromStatuses: readonly TaskStatusValue[];
  toStatus: TaskStatusValue;
  actor: string;
  reason: string | null;
  /** Extra `tasks` columns to set in the same `UPDATE` as `status`
   * (currently only `funding_tx_hash`, for the AWAITING_FUNDING→OPEN
   * transition) — column name (already-safe, not user input) to value. */
  extraColumns?: Record<string, unknown>;
  /**
   * Runs INSIDE the transaction, immediately after the row lock
   * (`lockTaskForTransition`'s `SELECT ... FOR UPDATE`) succeeds and BEFORE
   * any write — this is the only point where a business precondition (e.g.
   * "the deadline hasn't passed") can be checked without a TOCTOU gap: any
   * check done by the caller before calling `transitionTaskStatus` could
   * still pass, then block waiting for this function's own row lock while
   * another transaction changes the row, and only see stale data by the
   * time it's the one actually writing (Codex review, T-605 round 3 —
   * human review). Returning `{ ok: false, reason }` aborts the whole
   * transition: ROLLBACK, no status UPDATE, no `task_state_history` row —
   * this function returns `{ outcome: "precondition_failed", reason }`
   * instead of ever reaching "transitioned". The callback receives `client`
   * (not a pre-fetched row) so it can read whatever columns it needs itself
   * under the lock, the same way `withinTransaction` below does.
   */
  precondition?: (client: PoolClient) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Runs inside the same transaction as the status UPDATE + history insert,
   * after both have executed but before COMMIT, sharing the row lock this
   * function already took. This is what lets `recordFundingConfirmation`
   * below insert `chain_transactions`/`chain_events` atomically with the
   * AWAITING_FUNDING→OPEN transition — "任务状态是 OPEN" and "资金交易已记录"
   * must never be observably out of sync, so they commit together or not
   * at all.
   */
  withinTransaction?: (client: PoolClient) => Promise<void>;
}

/**
 * The single reusable state-transition primitive both `createFundingIntent`
 * (DRAFT→AWAITING_FUNDING) and `recordFundingConfirmation`
 * (AWAITING_FUNDING→OPEN) call, instead of each hand-writing its own
 * `UPDATE tasks ... ; INSERT INTO task_state_history ...` pair. Locks the
 * row, verifies the current status is one of `allowedFromStatuses`, runs the
 * optional `precondition` under that same lock (aborting the whole
 * transition on failure — see its own doc comment on `TransitionTaskStatusInput`
 * for why this is the only TOCTOU-free place to put a business precondition
 * like "the deadline hasn't passed"), updates `status` (plus any
 * `extraColumns`), records the transition in `task_state_history`, and —
 * only for the funding-confirmation case — runs `withinTransaction` before
 * committing.
 */
export async function transitionTaskStatus(
  pool: Pool,
  input: TransitionTaskStatusInput,
): Promise<TaskTransitionResult> {
  const client = await pool.connect();
  let lock: LockOutcome;
  try {
    await client.query("BEGIN");
    lock = await lockTaskForTransition(client, input.taskId, input.allowedFromStatuses);
    if (lock.outcome !== "ok") {
      await client.query("ROLLBACK");
      return lock;
    }

    if (input.precondition) {
      const check = await input.precondition(client);
      if (!check.ok) {
        await client.query("ROLLBACK");
        return { outcome: "precondition_failed", reason: check.reason };
      }
    }

    const extraEntries = Object.entries(input.extraColumns ?? {});
    const setClauses = [
      "status = $2",
      "updated_at = now()",
      ...extraEntries.map(([column], index) => `${column} = $${index + 3}`),
    ];
    await client.query(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = $1`, [
      input.taskId,
      input.toStatus,
      ...extraEntries.map(([, value]) => value),
    ]);

    await insertStateHistory(
      client,
      input.taskId,
      lock.currentStatus,
      input.toStatus,
      input.actor,
      input.reason,
    );

    if (input.withinTransaction) {
      await input.withinTransaction(client);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const task = await getTaskById(pool, input.taskId);
  if (!task) {
    // Defensive: same reasoning as updateTaskDraft's identical branch above
    // — not expected to be reachable (no delete endpoint exists).
    return { outcome: "not_found" };
  }
  return { outcome: "transitioned", task };
}

export interface InsertChainTransactionInput {
  /** Already-lowercased — callers normalize once at the service boundary
   * (matching `checkTransactionNotUsed`'s own normalization), this function
   * does not re-normalize. */
  txHash: string;
  chainId: number;
  taskId: string;
  /** `chain_transactions.purpose` is a free TEXT column (0005_create_tasks.sql:
   * "purpose(FUNDING|ACCEPTANCE|...)" — the full set is deliberately not a
   * closed DB-level enum), so adding `"ACCEPTANCE"` (T-801),
   * `"RESULT_SUBMISSION"` (T-905), `"SETTLEMENT"` (T-1001 — covers all
   * three of `ResultApproved`/`DeliveryTimeoutClaimed`/
   * `ReviewTimeoutFinalized`, distinguished by `chain_events.event_name`
   * instead of a separate purpose per event), `"DISPUTE_OPEN"`/
   * `"DISPUTE_RESOLVE"` (T-1002), and `"CANCELLATION"` (Feature 17,
   * T-1705 — the first real caller of `TaskEscrow.cancelTask`/
   * `TaskCancelled` in this codebase; Feature 6 defined the `CANCELLED`
   * status/event name but never built a verification path for it) here
   * needed no migration — only widening this call-site type to the
   * purposes this codebase actually issues today. */
  purpose:
    | "FUNDING"
    | "ACCEPTANCE"
    | "RESULT_SUBMISSION"
    | "SETTLEMENT"
    | "DISPUTE_OPEN"
    | "DISPUTE_RESOLVE"
    | "CANCELLATION";
  status: "confirmed";
  confirmations: number;
}

/**
 * Records one `chain_transactions` row for a verified funding transaction.
 * Takes a `Queryable` (not `Pool`) so `recordFundingConfirmation` below can
 * call it with the same `PoolClient` its status transition already holds
 * the row lock on, keeping both writes in one transaction.
 *
 * `ON CONFLICT (chain_id, tx_hash) DO NOTHING` (mirroring `insertChainEvent`'s
 * already-established idempotent-write pattern above, rather than a second
 * pattern) is what makes the `chain_transactions_chain_tx_hash_unique`
 * constraint a safe, race-free source of truth for "is this txHash already
 * claimed": two concurrent `verifyFunding` calls for different tasks
 * submitting the same `txHash` both reach this INSERT inside their own
 * `transitionTaskStatus` transaction; exactly one row is ever created, and
 * neither caller gets an unhandled unique-violation exception. The boolean
 * return tells the caller whether *this* call is the one that actually
 * created the row (`true`) or lost the race / is a same-task retry
 * (`false`, `RETURNING id` produced no row) — service.ts uses that to decide
 * whether it needs to look up who actually owns the existing row.
 */
export async function insertChainTransaction(
  client: Queryable,
  input: InsertChainTransactionInput,
): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO chain_transactions (tx_hash, chain_id, task_id, purpose, status, confirmations, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (chain_id, tx_hash) DO NOTHING
     RETURNING id`,
    [input.txHash, input.chainId, input.taskId, input.purpose, input.status, input.confirmations],
  );
  return rows.length > 0;
}

/**
 * Reads back the `task_id` currently bound to `(chainId, txHash)` inside an
 * already-open transaction's `client` — the read half of the race resolved
 * by `insertChainTransaction`'s `ON CONFLICT DO NOTHING` above: when that
 * insert reports it did *not* create the row, this is how the caller finds
 * out which task actually owns it (itself, in a same-task retry, or a
 * different task, in a genuine `TRANSACTION_ALREADY_USED` conflict).
 */
export async function findChainTransactionOwner(
  client: Queryable,
  chainId: number,
  txHash: string,
): Promise<string | null> {
  const { rows } = await client.query<{ task_id: string }>(
    `SELECT task_id FROM chain_transactions WHERE chain_id = $1 AND tx_hash = $2`,
    [chainId, txHash],
  );
  return rows[0]?.task_id ?? null;
}

export interface InsertChainEventInput {
  chainId: number;
  /** Already-lowercased 32-byte hex, matching the columns' own CHECK
   * constraints (0005_create_tasks.sql). */
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  eventName: string;
  taskId: string;
  /** JSON-serializable decoded event fields — stored as-is in the `payload`
   * JSONB column. */
  payload: unknown;
}

/**
 * Records one `chain_events` row for a decoded `TaskFunded` log.
 * `ON CONFLICT (chain_id, block_hash, transaction_hash, log_index) DO
 * NOTHING` is F-606's "复核逻辑幂等，可重复执行不产生重复结果" enforced at the
 * database layer, not by the caller first checking "have I seen this
 * event before" in application code — a second call with the exact same
 * log identity (e.g. a retried request that reaches this point again due
 * to a network blip after the first COMMIT) silently no-ops instead of
 * violating the table's UNIQUE constraint or creating a duplicate row.
 *
 * Every row this function ever writes is, by construction, ALREADY final
 * (T-905 human N4 follow-up, round-cap already exhausted): every call site
 * (`verifyFunding`/`verifyAcceptance`/`verifyResultSubmission`) only
 * reaches this insert after its own confirmations check already passed —
 * there is no "unconfirmed chain_events row" for any event type, which is
 * why reorg-rollback for `ResultSubmitted` operates on a separate,
 * dedicated `pending_result_submissions` table (repository.ts, this same
 * file) instead of on this one.
 */
export async function insertChainEvent(
  client: Queryable,
  input: InsertChainEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO chain_events
       (chain_id, block_hash, transaction_hash, log_index, event_name, task_id, payload, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (chain_id, block_hash, transaction_hash, log_index) DO NOTHING`,
    [
      input.chainId,
      input.blockHash,
      input.transactionHash,
      input.logIndex,
      input.eventName,
      input.taskId,
      JSON.stringify(input.payload),
    ],
  );
}

// ---------------------------------------------------------------------
// T-605: GET /tasks (list/filter), GET /tasks/:taskId/history
// ---------------------------------------------------------------------

/** Every status a task can be in once it has left `DRAFT`/`AWAITING_FUNDING`
 * — the exact set AC-607's public market query is restricted to ("公开市场只
 * 展示 OPEN 及以后状态"). Kept as a named constant (not inlined into the SQL
 * string) so the "9 statuses minus the two pre-publication ones" derivation
 * is visible at a glance rather than requiring the reader to diff it against
 * TaskStatusValue by hand. */
const PUBLIC_MARKET_STATUSES: readonly TaskStatusValue[] = [
  "OPEN",
  "ACCEPTED",
  "SUBMITTED",
  "DISPUTED",
  "RELEASED",
  "REFUNDED",
  "CANCELLED",
];

export interface ListTasksFilter {
  requester?: string;
  /** T-805: filters `tasks.accepted_agent_address` — same public-filter
   * status as `category`/`skillTag` (see `listTasksQuerySchema`'s doc
   * comment, schema.ts): no `restrictToPublicStatuses`-style authorization
   * gate needed, an accepted agent's address is already visible on every
   * published task. */
  acceptedBy?: string;
  status?: TaskStatusValue;
  category?: string;
  skillTag?: string;
  page: number;
  pageSize: number;
  /**
   * Whether DRAFT/AWAITING_FUNDING tasks must be excluded regardless of
   * `status`/`requester`. This is an explicit, caller-supplied decision —
   * NOT inferred here from whether `requester` happens to be set — because
   * inferring it from `requester`'s mere presence let an anonymous caller
   * pass ANY address as `requester` and see that address's unpublished
   * drafts (title/description/budget/deadline), with no session check
   * anywhere in this function (Codex review, T-605 round 1, P1). Only
   * service.ts knows whether the request is authenticated as the exact
   * `requester` being queried, so only it is allowed to set this to
   * `false`; this function trusts whatever it's told and does not try to
   * re-derive authorization from the shape of the filter.
   */
  restrictToPublicStatuses: boolean;
}

export interface ListTasksResult {
  items: TaskRow[];
  total: number;
}

interface TaskListQueryRow extends TaskQueryRow {
  skill_tags: string[];
}

/**
 * T-605/F-608: paginated/filtered task listing, shaped after agents/
 * repository.ts's `listAgents` (same reviewed fixes carried over rather than
 * re-derived): `total` comes from an independent `count(*)` query using the
 * same WHERE clause, not a `count(*) OVER()` window on the page query itself
 * — a page beyond the last populated one returns zero rows, and a window
 * function computed from zero rows would misreport `total` as 0 too (T-503
 * round 1 P2). Ordered by `created_at DESC, id DESC` so pagination is
 * deterministic even when two tasks share a `created_at` timestamp (same
 * reasoning as `listAgents`). `skillTag` filters via an `EXISTS` subquery so
 * the separate `LEFT JOIN task_skills` used to collect each task's own full
 * tag list isn't narrowed down to only the matching tag.
 *
 * The AC-606/AC-607 distinction (`restrictToPublicStatuses`) is decided by
 * the CALLER (service.ts), not inferred here from whether `filter.requester`
 * happens to be set (Codex review, T-605 round 1, P1 — see
 * `ListTasksFilter.restrictToPublicStatuses`'s own doc comment for why):
 *
 * - AC-607 ("公开市场只展示 OPEN 及以后状态"): `restrictToPublicStatuses: true`
 *   — DRAFT/AWAITING_FUNDING tasks are excluded regardless of `status`/
 *   `requester`, because the caller isn't authenticated as the exact
 *   `requester` being queried (or no `requester` was given at all).
 * - AC-606 ("我的发布"列表能展示草稿、待确认、开放等状态"): `restrictToPublicStatuses:
 *   false` — only when service.ts has confirmed the authenticated session
 *   address matches `filter.requester` exactly. `filter.status`, if also
 *   given, governs on top of that (including `status=DRAFT`); otherwise
 *   every status for that requester is returned.
 *
 * These are two different WHERE fragments (not one shared boolean), kept
 * intentionally separate below rather than collapsed into a single
 * `status IN (...)` condition — merging them would make it easy to
 * accidentally apply the public-market restriction to a `requester`-scoped
 * query (or vice versa) the next time this function is touched.
 */
export async function listTasks(
  pool: Queryable,
  filter: ListTasksFilter,
): Promise<ListTasksResult> {
  const offset = (filter.page - 1) * filter.pageSize;

  const filterParams = [
    filter.requester ?? null,
    filter.status ?? null,
    filter.category ?? null,
    filter.skillTag ?? null,
    filter.restrictToPublicStatuses ? PUBLIC_MARKET_STATUSES : null,
    filter.acceptedBy ?? null,
  ];
  const filterWhere = `
    WHERE ($1::text IS NULL OR t.requester_address = $1)
      AND ($2::text IS NULL OR t.status = $2)
      AND ($3::text IS NULL OR t.category = $3)
      AND (
        $4::text IS NULL
        OR EXISTS (
          SELECT 1 FROM task_skills s2 WHERE s2.task_id = t.id AND s2.skill_tag = $4
        )
      )
      AND ($5::text[] IS NULL OR t.status = ANY($5))
      AND ($6::text IS NULL OR t.accepted_agent_address = $6)
  `;

  const [itemsResult, countResult] = await Promise.all([
    pool.query<TaskListQueryRow>(
      `SELECT t.id, t.requester_address, t.category, t.title, t.description, t.budget, t.token,
              t.delivery_deadline, t.status, t.funding_tx_hash, t.idempotency_key,
              t.created_at, t.updated_at, t.accepted_agent_address, t.accepted_at,
              COALESCE(
                array_agg(s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL),
                '{}'
              ) AS skill_tags
       FROM tasks t
       LEFT JOIN task_skills s ON s.task_id = t.id
       ${filterWhere}
       GROUP BY t.id
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $7 OFFSET $8`,
      [...filterParams, filter.pageSize, offset],
    ),
    pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM tasks t ${filterWhere}`,
      filterParams,
    ),
  ]);

  const items = itemsResult.rows.map((row) => toTaskRow(row, row.skill_tags));
  const total = Number(countResult.rows[0]?.total ?? "0");
  return { items, total };
}

export interface TaskStateHistoryEntry {
  fromStatus: TaskStatusValue | null;
  toStatus: TaskStatusValue;
  actor: string;
  reason: string | null;
  occurredAt: Date;
}

/**
 * T-605: reads back every `task_state_history` row for `taskId`, ordered by
 * `occurred_at ASC` (time ascending) — a history view reads naturally as
 * "what happened, in the order it happened," not most-recent-first.
 * Returns an empty array for a task with no recorded transitions yet (e.g.
 * a still-DRAFT task that has never gone through `transitionTaskStatus`) as
 * well as for a nonexistent `taskId`; distinguishing "exists, no history"
 * from "doesn't exist" is routes.ts's job (a separate `getTaskById` call),
 * not this function's.
 */
export async function getTaskHistory(
  pool: Queryable,
  taskId: string,
): Promise<TaskStateHistoryEntry[]> {
  const { rows } = await pool.query<{
    from_status: TaskStatusValue | null;
    to_status: TaskStatusValue;
    actor: string;
    reason: string | null;
    occurred_at: Date;
  }>(
    `SELECT from_status, to_status, actor, reason, occurred_at
     FROM task_state_history
     WHERE task_id = $1
     ORDER BY occurred_at ASC`,
    [taskId],
  );
  return rows.map((row) => ({
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    reason: row.reason,
    occurredAt: row.occurred_at,
  }));
}

export interface ChainTransactionRow {
  taskId: string;
  confirmations: number;
  status: string;
}

/**
 * Reads back a previously-recorded `chain_transactions` row by
 * `(chainId, txHash)`. `verifyFunding` (service.ts) uses this for the F-606
 * idempotent-replay path — when a task is already `OPEN` and the
 * resubmitted `txHash` matches its `funding_tx_hash`, this is how the
 * response's `confirmations` figure is recovered without re-querying the
 * chain a second time.
 */
// ---------------------------------------------------------------------
// T-705: candidate-snapshot assembly support for POST /tasks/:taskId/match.
// ---------------------------------------------------------------------

/** The `tasks.status` values that count as "this Agent currently occupies a
 * capacity slot" — F-711's concurrent-capacity scope, owned by `tasks`
 * (the table that actually knows what each status means), not duplicated
 * into `modules/dispatch` (T-705 capsule: "这是 tasks 表自己的领域知识... dispatch
 * 模块只调用它，不复制状态集合"). Matches
 * dispatch-matching-migration.integration.test.ts's own hardcoded
 * `IN ('ACCEPTED','SUBMITTED','DISPUTED')` list (T-700), which this
 * function is the real implementation of. */
const OCCUPYING_STATUSES: readonly TaskStatusValue[] = ["ACCEPTED", "SUBMITTED", "DISPUTED"];

/**
 * T-705: counts, per Agent, how many `tasks` rows are currently occupying
 * one of that Agent's capacity slots (`accepted_agent_id = ANY(agentIds)
 * AND status IN (...)`) — `assembleCandidateSnapshots` (dispatch/repository.ts)
 * is this function's only caller, feeding the result into each candidate
 * snapshot's `activeTaskCount`.
 *
 * `agentIds` empty → returns an empty Map without querying at all: `= ANY('{}')`
 * is a valid but wasted round-trip for a case the caller (an empty candidate
 * pool) already knows produces no rows.
 */
export async function countActiveTasksByAgentIds(
  client: Queryable,
  agentIds: string[],
): Promise<Map<string, number>> {
  if (agentIds.length === 0) {
    return new Map();
  }
  const { rows } = await client.query<{ accepted_agent_id: string; count: string }>(
    `SELECT accepted_agent_id, COUNT(*) AS count
     FROM tasks
     WHERE accepted_agent_id = ANY($1) AND status = ANY($2)
     GROUP BY accepted_agent_id`,
    [agentIds, OCCUPYING_STATUSES],
  );
  return new Map(rows.map((row) => [row.accepted_agent_id, Number(row.count)]));
}

export interface AcceptedTaskForPolling {
  id: string;
  acceptedAgentAddress: string;
}

/**
 * T-905's background poller (result-submission-poller.ts) needs exactly
 * these two fields for every currently-`ACCEPTED` task: `id` (to derive
 * the on-chain task id and to call `verifyResultSubmission`) and
 * `acceptedAgentAddress` (the poller has no authenticated "session" — it
 * passes this already-known value as `verifyResultSubmission`'s
 * `sessionAddress` parameter, which the contract's own `task.agent ==
 * msg.sender` enforcement guarantees will match whatever a real
 * `ResultSubmitted` event's `agent` field decodes to). `acceptedAgentAddress`
 * is non-null by construction: `status = 'ACCEPTED'` is only ever reached
 * via `verifyAcceptance`'s transition, which always sets it in the same
 * UPDATE (design.md's "四者原子一致").
 */
export async function listAcceptedTasksForPolling(
  pool: Queryable,
): Promise<AcceptedTaskForPolling[]> {
  const { rows } = await pool.query<{ id: string; accepted_agent_address: string }>(
    `SELECT id, accepted_agent_address FROM tasks WHERE status = 'ACCEPTED'`,
  );
  return rows.map((row) => ({ id: row.id, acceptedAgentAddress: row.accepted_agent_address }));
}

export interface PendingResultSubmissionRow {
  id: string;
  taskId: string;
  chainId: number;
  transactionHash: string;
  logIndex: number;
  blockHash: string;
  blockNumber: bigint;
  agentAddress: string;
}

export interface InsertPendingResultSubmissionInput {
  taskId: string;
  chainId: number;
  transactionHash: string;
  logIndex: number;
  blockHash: string;
  blockNumber: bigint;
  agentAddress: string;
}

/**
 * Human N4 follow-up (T-905, human review round B — pure human finding, no
 * 3rd Codex call, round cap already exhausted): round-A's reorg-rollback
 * design operated on `chain_events`, but `verifyResultSubmission` only ever
 * writes a `chain_events`/`RESULT_SUBMISSION` row AFTER its own internal
 * `confirmations >= resolveRequiredConfirmations()` check already passed —
 * so every such row is, by construction, already final, and a "roll back an
 * unconfirmed chain_events projection" check can never have anything to do
 * (dead code; see this repository's own git history / the evidence packet
 * for the concrete proof this was actually never reachable).
 *
 * This table is the fix: a genuinely separate, dedicated place to hold a
 * *discovered-but-not-yet-final* `ResultSubmitted` log — `tasks.status`
 * never moves off `ACCEPTED` because of a row here. Only once a pending row
 * reaches `resolveRequiredConfirmations()` does the poller call the
 * already-reviewed `verifyResultSubmission` path to actually promote it,
 * exactly like today's HTTP-triggered or forward-scan-triggered call — this
 * table adds a waiting room in front of that path, it does not change what
 * "confirmed" means or how a task is ever promoted.
 *
 * `ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING` makes
 * the forward-scan's insert naturally idempotent — the same log rediscovered
 * on a later tick (this poller always re-scans the full range, per N4 round
 * 2) is simply a no-op here, not a duplicate pending row.
 *
 * Only carries what the promotion pass actually reads: identity
 * (`taskId`/`chainId`/`transactionHash`/`logIndex`), what a reorg check
 * needs (`blockHash`/`blockNumber`), and what a poller-discovered
 * `verifyResultSubmission` call needs in place of a real session
 * (`agentAddress`). Round B originally also stored the decoded
 * `resultHash`/`submittedAt`/`reviewDeadline` here, but nothing in the
 * promotion path ever read them — `verifyResultSubmission` always
 * independently re-fetches the receipt and re-decodes the event itself
 * before trusting any of those fields (this table is a lead to
 * investigate, never itself the source of truth for on-chain data) — so
 * they were dropped as unused rather than kept "for later" (CLAUDE.md
 * 原则 4: no speculative fields).
 *
 * Returns whether a row was actually inserted (`true`) vs. a no-op
 * conflict (`false`) — human N4 follow-up (round B, P2): the caller needs
 * this to count only genuinely NEW pending rows, not every rediscovery of
 * an already-pending log on a later tick.
 */
export async function insertPendingResultSubmission(
  pool: Queryable,
  input: InsertPendingResultSubmissionInput,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO pending_result_submissions
       (task_id, chain_id, transaction_hash, log_index, block_hash, block_number, agent_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING`,
    [
      input.taskId,
      input.chainId,
      input.transactionHash,
      input.logIndex,
      input.blockHash,
      input.blockNumber.toString(),
      input.agentAddress,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Every currently-pending row for a chain — the promotion pass (poller)
 * evaluates each one every tick: not yet at `resolveRequiredConfirmations()`
 * → reorg-checked via `event-sync.ts`'s `checkProjectionForReorg` (the one
 * reorg rule this whole codebase uses); at or past it → promoted via
 * `verifyResultSubmission`. No `tasks.status` filter needed here (unlike
 * the old, dead `chain_events`-based query) — a pending row's very
 * existence already means the task hasn't been promoted yet; once
 * `verifyResultSubmission` succeeds, the caller deletes this row (see
 * `deletePendingResultSubmission`), so a promoted task simply has no row
 * left to reconsider.
 */
export async function listPendingResultSubmissions(
  pool: Queryable,
  chainId: number,
): Promise<PendingResultSubmissionRow[]> {
  const { rows } = await pool.query<{
    id: string;
    task_id: string;
    chain_id: number;
    transaction_hash: string;
    log_index: number;
    block_hash: string;
    block_number: string;
    agent_address: string;
  }>(
    `SELECT id, task_id, chain_id, transaction_hash, log_index, block_hash, block_number, agent_address
     FROM pending_result_submissions
     WHERE chain_id = $1`,
    [chainId],
  );
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    chainId: row.chain_id,
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    blockHash: row.block_hash,
    blockNumber: BigInt(row.block_number),
    agentAddress: row.agent_address,
  }));
}

/**
 * Removes a pending row after it is no longer "pending" for either reason:
 * successfully promoted (the task is now `SUBMITTED` via
 * `verifyResultSubmission`, so this row's job is done), or reorged away
 * (the log it was discovered from is no longer canonical — nothing to
 * promote; a future tick's forward scan will naturally insert a fresh
 * pending row for whatever canonical log, if any, replaces it). Deleting a
 * single row by its own `id` is a single-statement, non-transactional
 * operation — unlike the old design, there is no `tasks` status change to
 * keep atomic with this deletion, since a pending row's existence never
 * implied any change to `tasks` in the first place.
 */
export async function deletePendingResultSubmission(pool: Queryable, id: string): Promise<void> {
  await pool.query(`DELETE FROM pending_result_submissions WHERE id = $1`, [id]);
}

/**
 * `purpose` is optional and, when passed, narrows the lookup to rows
 * recorded for that purpose (Codex review, T-801 round 1, P2): without it,
 * a task's own `FUNDING` transaction hash would satisfy a caller's
 * `(chainId, txHash, taskId)` replay check meant for a DIFFERENT purpose
 * (e.g. `verifyAcceptance`'s idempotent-replay lookup), since both rows
 * share the same `taskId` — `chain_transactions.purpose` is the only column
 * that actually distinguishes them. The two `FUNDING` call sites
 * (`verifyFunding`) don't need this: they already gate on
 * `task.fundingTxHash === normalizedTxHash` first, so they can only ever
 * reach a `FUNDING` row.
 */
export async function getChainTransactionByHash(
  pool: Queryable,
  chainId: number,
  txHash: string,
  purpose?: string,
): Promise<ChainTransactionRow | null> {
  const { rows } = await pool.query<{ task_id: string; confirmations: number; status: string }>(
    purpose
      ? `SELECT task_id, confirmations, status FROM chain_transactions
         WHERE chain_id = $1 AND tx_hash = $2 AND purpose = $3`
      : `SELECT task_id, confirmations, status FROM chain_transactions WHERE chain_id = $1 AND tx_hash = $2`,
    purpose ? [chainId, txHash.toLowerCase(), purpose] : [chainId, txHash.toLowerCase()],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { taskId: row.task_id, confirmations: row.confirmations, status: row.status };
}
