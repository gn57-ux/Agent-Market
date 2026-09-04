import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresIdempotencyLedger } from "../src/postgres-idempotency-ledger.js";

/**
 * AC-1802's real proof: "同一条消息被消费两次（模拟至少一次语义的重复投递），
 * 最终业务状态与只消费一次时一致". `processed_events`
 * (`apps/api/migrations/0029_create_processed_events.sql`) lives in
 * `apps/api`'s migrations (the single migration source of truth for this
 * project's whole business DB — same reasoning `chain_indexed_events`'s
 * own migration documents), applied here via that raw SQL file directly —
 * this suite only needs the one table it exercises, mirroring
 * `apps/indexer`'s own `repository.integration.test.ts` pattern.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

function requireConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("RUN_DB_INTEGRATION_TESTS=1 requires TEST_DATABASE_URL");
  return url;
}

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/api/migrations/0029_create_processed_events.sql",
);

runIfOptedIn("createPostgresIdempotencyLedger (integration, T-1802)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireConnectionString() });
    const sql = await readFile(migrationPath, "utf8");
    await pool.query(`DROP TABLE IF EXISTS processed_events`);
    await pool.query(sql);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS processed_events`);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM processed_events");
  });

  it("AC-1802: the same event id processed twice runs the real business effect exactly once, with atomicity between the ledger record and the effect", async () => {
    const ledger = createPostgresIdempotencyLedger(pool, "test-consumer");
    const eventId = randomUUID();

    // A real "business effect" using the SAME transaction runOnce hands
    // to `work` — a real table write that commits or rolls back together
    // with the ledger record.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS test_business_effects (event_id UUID PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );

    const first = await ledger.runOnce(eventId, async (tx) => {
      await tx.query(`INSERT INTO test_business_effects (event_id) VALUES ($1)`, [eventId]);
      return "applied";
    });
    expect(first.alreadyProcessed).toBe(false);
    expect(first.result).toBe("applied");

    // Simulated redelivery of the exact same event id.
    const secondHandlerCalls: string[] = [];
    const second = await ledger.runOnce(eventId, async () => {
      secondHandlerCalls.push("should not run");
      return "applied-again";
    });
    expect(second.alreadyProcessed).toBe(true);
    expect(secondHandlerCalls).toEqual([]);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM test_business_effects WHERE event_id = $1`,
      [eventId],
    );
    expect(rows[0]?.count).toBe("1");

    await pool.query(`DROP TABLE test_business_effects`);
  });

  it("a handler that throws leaves NO ledger record — a genuine retry of the same event id is allowed to actually run again", async () => {
    const ledger = createPostgresIdempotencyLedger(pool, "test-consumer");
    const eventId = randomUUID();

    await expect(
      ledger.runOnce(eventId, async () => {
        throw new Error("simulated business-effect failure");
      }),
    ).rejects.toThrow("simulated business-effect failure");

    const { rows: afterFailure } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM processed_events WHERE consumer_name = 'test-consumer' AND event_id = $1`,
      [eventId],
    );
    expect(afterFailure[0]?.count).toBe("0");

    // A real retry after the failure genuinely runs the handler.
    const retryCalls: string[] = [];
    const retryResult = await ledger.runOnce(eventId, async () => {
      retryCalls.push("ran");
      return "ok";
    });
    expect(retryResult.alreadyProcessed).toBe(false);
    expect(retryCalls).toEqual(["ran"]);
  });

  it("two different consumer_name scopes are independent — one consumer's processing does not block another's on the same event id", async () => {
    const eventId = randomUUID();
    const ledgerA = createPostgresIdempotencyLedger(pool, "consumer-a");
    const ledgerB = createPostgresIdempotencyLedger(pool, "consumer-b");

    const resultA = await ledgerA.runOnce(eventId, async () => "a");
    const resultB = await ledgerB.runOnce(eventId, async () => "b");

    expect(resultA.alreadyProcessed).toBe(false);
    expect(resultB.alreadyProcessed).toBe(false);
  });

  it("N4 real finding (P2): a non-UUID eventId is rejected immediately with a clear error, not a raw Postgres 'invalid input syntax for type uuid' failure", async () => {
    const ledger = createPostgresIdempotencyLedger(pool, "test-consumer");
    const handlerCalls: string[] = [];

    await expect(
      ledger.runOnce("not-a-real-uuid", async () => {
        handlerCalls.push("should not run");
      }),
    ).rejects.toThrow(/must be a UUID/);
    expect(handlerCalls).toEqual([]);
  });
});
