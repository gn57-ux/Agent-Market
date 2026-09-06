import type { Queryable } from "../../db/pool.js";

/**
 * F-1901/F-1902 (T-1901): the one function that knows `interaction_events`'s
 * columns (CLAUDE.md 原则 6 — this table's write knowledge has exactly one
 * owner). Two real callers use it: `POST /analytics/events` below (VIEW/
 * CLICK, direct write — no other business write needs to be atomic with a
 * page view) and the outbox consumer for the other 7 event types (EXPOSURE/
 * ACCEPT/SUBMIT/APPROVE/RATE/REFUND/DISPUTE), which applies the payload a
 * business endpoint already wrote to `outbox_events` inside its own
 * transaction (see e.g. `dispatch/routes.ts`'s EXPOSURE write).
 *
 * `Queryable` (not `PoolClient`): unlike `outbox/repository.ts`'s
 * `writeOutboxEvent`, this insert carries no cross-table atomicity
 * requirement of its own — AC-1902's dedup guarantee lives entirely in the
 * `client_event_id UNIQUE` constraint (T-1900), and `ON CONFLICT DO NOTHING`
 * makes a duplicate call a safe no-op regardless of which connection runs
 * it.
 */
export interface InsertInteractionEventInput {
  eventType: string;
  sessionId: string;
  clientEventId: string;
  taskId?: string;
  agentId?: string;
  runId?: string;
  actorAddress?: string;
}

export async function insertInteractionEvent(
  client: Queryable,
  input: InsertInteractionEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO interaction_events
       (event_type, session_id, client_event_id, task_id, agent_id, run_id, actor_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (client_event_id) DO NOTHING`,
    [
      input.eventType,
      input.sessionId,
      input.clientEventId,
      input.taskId ?? null,
      input.agentId ?? null,
      input.runId ?? null,
      input.actorAddress ?? null,
    ],
  );
}

/**
 * N4 real finding (P2, T-1901 round 1 — widened in round 2 after a second
 * real finding on the round-1 version): `POST /analytics/events` is
 * intentionally anonymous-reachable (VIEW/CLICK happen before a wallet is
 * connected), but that also means an unauthenticated caller could name any
 * real `taskId`/`agentId`/`runId` combination — the FK constraints on
 * `interaction_events` only prove each id individually EXISTS, not that
 * they were ever genuinely associated. Left unchecked, a caller could
 * fabricate arbitrary VIEW/CLICK volume for identifiers that were never
 * really linked, poisoning exactly the funnel data F-1922's online-learning
 * loop trains on.
 *
 * Round 1 only checked the (runId, agentId) pair when BOTH were present —
 * Codex round 2 correctly found that left every other combination
 * unchecked: a `taskId` that doesn't belong to the named `runId` (with
 * `agentId` omitted), or an arbitrary `taskId`/`agentId` pair with `runId`
 * omitted entirely (bypassing the candidate-table check altogether). This
 * version closes the whole surface with one rule set: `agentId` only ever
 * means anything in the context of a specific recommendation run's
 * candidate slot (there is no other table associating an Agent with a
 * task-scoped click/exposure), so `agentId` without `runId` is rejected
 * outright; whenever `runId` is present, its OWN `task_id` is looked up and
 * (a) must match a caller-supplied `taskId`, and (b) if `agentId` is also
 * present, `recommendation_candidates` must have a real row for that exact
 * (runId, agentId) pair. A bare `taskId` with neither `runId` nor `agentId`
 * (an ordinary task-detail-page VIEW, not tied to any candidate slot) needs
 * no further check beyond the FK constraint already on that column.
 */
export type IdentifierAssociationCheck =
  | { ok: true }
  | { ok: false; reason: "agent_without_run" | "run_task_mismatch" | "not_a_real_candidate" };

export async function checkIdentifierAssociation(
  pool: Queryable,
  input: { taskId?: string; agentId?: string; runId?: string },
): Promise<IdentifierAssociationCheck> {
  if (input.agentId && !input.runId) {
    return { ok: false, reason: "agent_without_run" };
  }
  if (!input.runId) {
    return { ok: true };
  }

  const { rows } = await pool.query<{ task_id: string }>(
    `SELECT task_id FROM recommendation_runs WHERE id = $1`,
    [input.runId],
  );
  const run = rows[0];
  if (!run || (input.taskId && run.task_id !== input.taskId)) {
    return { ok: false, reason: "run_task_mismatch" };
  }

  if (input.agentId) {
    const { rows: candidateRows } = await pool.query(
      `SELECT 1 FROM recommendation_candidates WHERE run_id = $1 AND agent_id = $2`,
      [input.runId, input.agentId],
    );
    if (candidateRows.length === 0) {
      return { ok: false, reason: "not_a_real_candidate" };
    }
  }

  return { ok: true };
}
