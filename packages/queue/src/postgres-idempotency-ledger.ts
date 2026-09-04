import type { Pool, PoolClient } from "pg";
import type { IdempotencyLedger } from "./idempotent-consumer.js";

/**
 * Real Postgres-backed `IdempotencyLedger` (T-1802) — `processed_events`
 * (`apps/api/migrations/0029_create_processed_events.sql`) is generic
 * consumer-side infrastructure, not specific to `outbox_events`'s own
 * schema, so it lives here rather than in `apps/api`'s outbox module —
 * same "apps/worker (T-1804) will need this as a typed library import,
 * apps/api cannot be depended on as one" reasoning already established
 * for `claimPendingOutboxEvents` staying in `apps/api` (it DOES need
 * `outbox_events`-specific knowledge) versus this ledger (it does not).
 *
 * `INSERT ... ON CONFLICT (consumer_name, event_id) DO NOTHING` inside a
 * transaction is the atomic "have I already processed this" check: if the
 * insert reports 0 rows, another call already claimed this
 * `(consumerName, eventId)` pair (committed or still in-flight — `ON
 * CONFLICT` only resolves once the other transaction's insert itself
 * commits or rolls back, so a concurrent `runOnce` for the SAME event
 * blocks briefly rather than racing past the check, the same row-level
 * mutual exclusion `claimPendingOutboxEvents`'s `FOR UPDATE SKIP LOCKED`
 * relies on for the SAME underlying reason). `work` runs on that same
 * transaction's client, so its own business writes commit or roll back
 * together with the ledger record — a `work` failure leaves NO ledger
 * record (real retry stays possible), a `work` success commits both
 * atomically.
 *
 * N4 real finding (P2): `IdempotencyLedger.runOnce`'s public `eventId`
 * parameter is typed as a plain `string` — every real caller in this
 * codebase always passes an outbox event's own `id` (a genuine
 * `gen_random_uuid()` value, per `writeOutboxEvent`), but nothing in the
 * type system stops a future caller from passing an arbitrary string. The
 * `processed_events.event_id` column is `UUID`, so a non-UUID string
 * would fail deep inside a raw `pg` query with "invalid input syntax for
 * type uuid" instead of a clear, immediate error — and depending on how a
 * caller's own retry logic reacts to that generic DB error, could retry
 * forever without ever making progress. Fixed with a real runtime check
 * at this module's own boundary (CLAUDE.md 原则 8's "系统边界的运行时校验"),
 * before any connection is even checked out.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPostgresIdempotencyLedger(
  pool: Pool,
  consumerName: string,
): IdempotencyLedger<PoolClient> {
  return {
    async runOnce(eventId, work) {
      if (!UUID_PATTERN.test(eventId)) {
        throw new Error(
          `createPostgresIdempotencyLedger.runOnce: eventId must be a UUID (processed_events.event_id ` +
            `is UUID-typed), got: ${JSON.stringify(eventId)}`,
        );
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ event_id: string }>(
          `INSERT INTO processed_events (consumer_name, event_id)
             VALUES ($1, $2)
           ON CONFLICT (consumer_name, event_id) DO NOTHING
           RETURNING event_id`,
          [consumerName, eventId],
        );
        if (rows.length === 0) {
          await client.query("ROLLBACK");
          client.release();
          return { alreadyProcessed: true };
        }
        const result = await work(client);
        await client.query("COMMIT");
        client.release();
        return { alreadyProcessed: false, result };
      } catch (error) {
        // Same discipline as claimPendingOutboxEvents's own error path
        // (N4 round 2 fix): best-effort ROLLBACK (itself guarded, since
        // the connection may already be unusable), then release WITH the
        // error so `pg` destroys the connection instead of returning a
        // possibly-corrupt one to the pool.
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignored — release() below destroys the connection regardless
        }
        client.release(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
  };
}
