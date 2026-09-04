import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { getOutboxEventById, writeOutboxEvent } from "./repository.js";

/**
 * T-1800's own real proof — tasks.md's own paraphrase of AC-1801 for this
 * Task: "模拟事务内崩溃，outbox 记录与业务写入同生共死：要么都提交要么都不提交".
 * The full AC-1801 text ("重启后未发送的 outbox 记录仍然存在且会被重新发送")
 * ALSO requires a real publisher/relay actually resending — that is T-1801's
 * own scope (design.md's own Task split: T-1800 is the write half, T-1801
 * is "发布（outbox → 队列）"), not re-proven here.
 *
 * "模拟事务内崩溃" is proven the same way this project already proves
 * transaction atomicity elsewhere (no separate "crash simulation"
 * mechanism needed — a real, uncommitted transaction that never reaches
 * `COMMIT` IS what a real process crash before commit looks like from the
 * database's own point of view): open a real transaction, do a real
 * business write (`users`, the smallest always-present table) AND a real
 * `writeOutboxEvent` call, then either `ROLLBACK` (the crash case) or
 * `COMMIT` (the success case), and check both writes' fate match.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE";

/**
 * A pure TYPE-LEVEL assertion, never called anywhere — `tsc` still visits
 * every function body regardless of whether anything invokes it, so this
 * is a real, enforced compile-time proof that `writeOutboxEvent` rejects a
 * plain `Pool` (`repository.ts`'s own N4 P1 finding: the atomicity
 * contract depends on the caller passing an already-transaction-bound
 * `PoolClient`, not the whole pool). Deliberately kept OUTSIDE any `it()`
 * block — an executed `@ts-expect-error` line only suppresses the
 * compiler diagnostic, not the actual runtime call, so putting this
 * inside a test body would perform a real, unawaited, auto-committed
 * INSERT (N4 round-2 P2 finding on an earlier version of this file).
 */
function typeOnlyPoolRejection(poolArg: Pool): void {
  // @ts-expect-error Pool is not assignable to PoolClient
  void writeOutboxEvent(poolArg, {
    aggregateType: "test_aggregate",
    aggregateId: "00000000-0000-0000-0000-000000000099",
    eventType: "TEST_EVENT",
    payload: {},
  });
}

runIfOptedIn("writeOutboxEvent transactional atomicity (integration, T-1800)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM outbox_events");
    await pool.query("DELETE FROM users");
  });

  it("N4 real finding (P1): writeOutboxEvent rejects a plain Pool at compile time — a caller cannot bypass the transaction contract by accident", () => {
    // N4 real finding (P2, round 2): the previous version of this check
    // called `typeOnlyPoolRejection(pool)` directly inside the test body —
    // but `@ts-expect-error` only suppresses the COMPILER diagnostic, it
    // does not stop the code from actually running: this was a real,
    // unawaited INSERT against `pool` (auto-committed immediately, no
    // transaction to roll back), racing `afterEach`'s own cleanup and
    // risking a leftover row or an unhandled rejection after teardown.
    // Fixed by moving the check into a module-scope function that is only
    // ever TYPE-CHECKED (`tsc` visits every function body regardless of
    // whether anything calls it) and referencing — never invoking — it
    // here, so the assertion has zero runtime effect.
    void typeOnlyPoolRejection;
  });

  it("AC-1801 (T-1800's half): a real transaction rollback (simulated crash before commit) discards BOTH the business write and the outbox row — neither survives", async () => {
    const client = await pool.connect();
    const address = "0x" + "a1".repeat(20);
    let outboxId: string;
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO users (address) VALUES ($1)`, [address]);
      outboxId = await writeOutboxEvent(client, {
        aggregateType: "test_aggregate",
        aggregateId: "00000000-0000-0000-0000-000000000001",
        eventType: "TEST_EVENT",
        payload: { note: "simulated crash before commit" },
      });
      // The real crash simulation: this transaction never reaches COMMIT.
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const { rows: userRows } = await pool.query(`SELECT 1 FROM users WHERE address = $1`, [
      address,
    ]);
    expect(userRows).toHaveLength(0);

    const outboxRow = await getOutboxEventById(pool, outboxId);
    expect(outboxRow).toBeNull();
  });

  it("AC-1801 (T-1800's half): a real transaction commit persists BOTH the business write and the outbox row together", async () => {
    const client = await pool.connect();
    const address = "0x" + "b2".repeat(20);
    let outboxId: string;
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO users (address) VALUES ($1)`, [address]);
      outboxId = await writeOutboxEvent(client, {
        aggregateType: "test_aggregate",
        aggregateId: "00000000-0000-0000-0000-000000000002",
        eventType: "TEST_EVENT",
        payload: { note: "committed together" },
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const { rows: userRows } = await pool.query(`SELECT 1 FROM users WHERE address = $1`, [
      address,
    ]);
    expect(userRows).toHaveLength(1);

    const outboxRow = await getOutboxEventById(pool, outboxId);
    expect(outboxRow).not.toBeNull();
    expect(outboxRow?.aggregateType).toBe("test_aggregate");
    expect(outboxRow?.eventType).toBe("TEST_EVENT");
    expect(outboxRow?.payload).toEqual({ note: "committed together" });
    expect(outboxRow?.status).toBe("PENDING");
    expect(outboxRow?.sentAt).toBeNull();
  });

  it("outbox_events.status rejects a value outside the three-state enum", async () => {
    await expect(
      pool.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
           VALUES ('a', '00000000-0000-0000-0000-000000000003', 'b', '{}'::jsonb, 'NOT_A_REAL_STATE')`,
      ),
    ).rejects.toThrow();
  });

  it("all three outbox_events.status values are individually insertable", async () => {
    for (const status of ["PENDING", "SENT", "FAILED"]) {
      const { rows } = await pool.query<{ status: string }>(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
           VALUES ('a', gen_random_uuid(), 'b', '{}'::jsonb, $1) RETURNING status`,
        [status],
      );
      expect(rows[0]?.status).toBe(status);
    }
  });
});
