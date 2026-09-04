import type { Pool, PoolClient } from "pg";
import type { ClaimedBatch } from "@agent-market/queue";
import type { Queryable } from "../../db/pool.js";

/**
 * F-1801 (T-1800): the write half of the transactional outbox pattern —
 * design.md's own interface contract: "必须在调用方已开启的事务内执行，保证与
 * 业务写入原子提交". The caller passes the SAME `PoolClient` its own
 * business write already holds inside an open `BEGIN`/`COMMIT` — this
 * function never opens its own transaction, so there is no way to call it
 * "correctly" outside one; a caller reaching for this function is
 * implicitly promising a transaction already exists.
 *
 * N4 real finding (P1): this function's `client` parameter is
 * deliberately typed `PoolClient`, NOT the codebase's usual `Queryable`
 * (`tasks/repository.ts`'s `insertChainEvent`/`insertChainTransaction`
 * convention) — `Queryable = Pick<Pool | PoolClient, "query">` also
 * structurally accepts a plain `Pool`, and `pool.query(...)` silently runs
 * on its own auto-committed, independent connection. A caller that passed
 * `getPool()` here instead of the transaction's own `client` would compile
 * cleanly and the outbox row would survive even if the REAL business
 * transaction later rolled back — the exact atomicity guarantee this
 * function's entire reason for existing. Narrowing to `PoolClient`
 * specifically closes that one concrete misuse at compile time (a `Pool`
 * is not assignable to `PoolClient`); it does not (and structurally
 * cannot, without runtime transaction-state tracking) catch a `PoolClient`
 * that isn't currently inside an open transaction — that residual risk is
 * the same one every `Queryable`-typed function in this codebase already
 * carries, and is unaffected by this narrowing.
 */
export interface WriteOutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export async function writeOutboxEvent(
  client: PoolClient,
  input: WriteOutboxEventInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.aggregateType, input.aggregateId, input.eventType, JSON.stringify(input.payload)],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("writeOutboxEvent: INSERT ... RETURNING produced no row");
  }
  return id;
}

export interface OutboxEventRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  status: "PENDING" | "SENT" | "FAILED";
  createdAt: Date;
  sentAt: Date | null;
}

/**
 * Read-only helper for T-1800's own real test (proving atomicity) and for
 * T-1801's publisher (proving it actually found and sent the row) — kept
 * here rather than duplicated, since "how do I read back an outbox row by
 * id" is exactly the same question for both callers. Typed `Queryable`
 * (not `PoolClient`) — unlike `writeOutboxEvent`, a plain read carries no
 * atomicity contract to protect, so accepting either `Pool` or
 * `PoolClient` is genuinely safe here, matching this codebase's usual
 * convention for read-only helpers.
 *
 * N4 real finding (P2): `created_at`/`sent_at` were previously declared as
 * `string` — this project registers no custom `pg` type parser, so `pg`'s
 * own default behavior (a real `TIMESTAMPTZ` column comes back as a JS
 * `Date`) applies, matching `tasks/repository.ts`'s own established
 * `created_at: Date` convention. The old `string` typing would have typechecked
 * cleanly while being wrong about the actual runtime value — exactly the
 * kind of "compiles but lies" bug CLAUDE.md 原则 8 exists to prevent.
 */
export async function getOutboxEventById(
  client: Queryable,
  id: string,
): Promise<OutboxEventRow | null> {
  const { rows } = await client.query<{
    id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload: unknown;
    status: "PENDING" | "SENT" | "FAILED";
    created_at: Date;
    sent_at: Date | null;
  }>(
    `SELECT id, aggregate_type, aggregate_id, event_type, payload, status, created_at, sent_at
       FROM outbox_events WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

/**
 * F-1801's relay half (T-1801): the `RelaySource.claimPending` this
 * repository supplies to `@agent-market/queue`'s schema-agnostic
 * `relayPendingMessages` — that package deliberately knows nothing about
 * `outbox_events`'s columns (see its own `relay.ts` doc comment), so
 * every piece of `outbox_events` knowledge (including this claim query)
 * lives here (CLAUDE.md 原则 6).
 *
 * N4 real finding (P1, round 1 — see `relay.ts`'s own doc comment for the
 * full writeup): a plain "SELECT pending rows" + a separate "UPDATE one
 * row to SENT" gave two concurrent relay calls no way to avoid claiming
 * and publishing the SAME rows. Fixed with `SELECT ... FOR UPDATE SKIP
 * LOCKED` inside a transaction held open on ONE checked-out client for
 * the whole batch: a concurrent claim's own `FOR UPDATE SKIP LOCKED`
 * simply skips every row this transaction is still holding, so two relay
 * instances can never process the same row. `markSent` runs on that same
 * held client (so the update is part of the same transaction), and
 * `release()` commits everything and returns the client to the pool. If
 * the process crashes before `release()`, the transaction is never
 * committed — Postgres rolls it back automatically when the connection
 * drops, and the claimed rows revert to `PENDING`, available to the next
 * relay run (the residual "publish succeeded, then crashed before
 * release()" duplicate-delivery gap is inherent and documented in
 * `relay.ts`, not something this claim mechanism can close alone).
 *
 * Ordered by `created_at` so a relay processes older events first — not a
 * correctness requirement for this table (each row is independent), but
 * matches the intuitive "first written, first sent" expectation an
 * operator watching a growing backlog would have.
 */
export async function claimPendingOutboxEvents(
  pool: Pool,
  limit: number,
): Promise<ClaimedBatch<unknown>> {
  const client = await pool.connect();
  // N4 real finding (P1, round 2): if `BEGIN` or the claim `SELECT` itself
  // throws (a transient connection/DB error), the function previously
  // rejected before ever returning a `ClaimedBatch` — meaning nobody could
  // call `release()`, and the already-checked-out client stayed held
  // (possibly mid-transaction) forever. Repeated relay attempts under a
  // transient outage would exhaust the pool one connection at a time.
  // Fixed by wrapping initialization in its own try/catch: best-effort
  // ROLLBACK (itself wrapped, since the connection may already be broken
  // and unable to accept further commands), then release the client WITH
  // the error so `pg` destroys it instead of returning a possibly-corrupt
  // connection to the pool, then rethrow the original error.
  let rows: Array<{ id: string; payload: unknown }>;
  try {
    await client.query("BEGIN");
    ({ rows } = await client.query<{ id: string; payload: unknown }>(
      `SELECT id, payload FROM outbox_events
        WHERE status = 'PENDING'
        ORDER BY created_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    ));
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection may already be unusable — release() below still
      // destroys it regardless of whether ROLLBACK itself succeeded.
    }
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  let released = false;
  return {
    items: rows,
    async markSent(id: string) {
      await client.query(
        `UPDATE outbox_events SET status = 'SENT', sent_at = now() WHERE id = $1`,
        [id],
      );
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query("COMMIT");
        client.release();
      } catch (error) {
        // COMMIT itself failing means this connection is in an unknown
        // state (mid-transaction, possibly broken) — pass the error to
        // `release()` so `pg` destroys the connection instead of
        // returning a possibly-corrupt one to the pool for a future
        // caller to inherit.
        client.release(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
  };
}
