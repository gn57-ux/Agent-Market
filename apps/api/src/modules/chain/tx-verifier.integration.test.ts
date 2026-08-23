import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { checkTransactionNotUsed } from "./tx-verifier.js";

// See db/tasks-migration.integration.test.ts's header comment: skipped
// unless a human opts in with RUN_DB_INTEGRATION_TESTS=1 against a
// confirmed-safe TEST_DATABASE_URL. This suite is T-603's dedicated
// verification of `checkTransactionNotUsed` — the one F-605 check
// (交易哈希未绑定其他任务) that genuinely needs a real `chain_transactions`
// table and its `UNIQUE (chain_id, tx_hash)` constraint, not a fake.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const CHAIN_ID = 31337;

async function insertTask(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks
       (requester_address, category, title, description, budget, token, delivery_deadline, status)
     VALUES ($1, 'writing', 'Test Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'AWAITING_FUNDING')
     RETURNING id`,
    [REQUESTER_ADDRESS, TOKEN_ADDRESS],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("insertTask: INSERT ... RETURNING id returned no row");
  }
  return id;
}

function insertChainTransaction(pool: Pool, taskId: string, txHash: string, chainId = CHAIN_ID) {
  return pool.query(
    `INSERT INTO chain_transactions (tx_hash, chain_id, task_id, purpose, status)
     VALUES ($1, $2, $3, 'funding', 'confirmed')`,
    [txHash, chainId, taskId],
  );
}

runIfOptedIn("checkTransactionNotUsed (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS recommendation_candidates, recommendation_runs, task_state_history, chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("a brand new (chainId, txHash) pair is not used", async () => {
    const taskId = await insertTask(pool);
    const txHash = "0x" + "1".repeat(64);

    const result = await checkTransactionNotUsed(pool, CHAIN_ID, txHash, taskId);

    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with TRANSACTION_ALREADY_USED when the tx is bound to a different task", async () => {
    const taskAId = await insertTask(pool);
    const taskBId = await insertTask(pool);
    const txHash = "0x" + "2".repeat(64);
    await insertChainTransaction(pool, taskAId, txHash);

    const result = await checkTransactionNotUsed(pool, CHAIN_ID, txHash, taskBId);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRANSACTION_ALREADY_USED");
    expect(result.message).toContain(taskAId);
  });

  it("returns ok:true when the tx is already bound to the SAME task (idempotent re-verification)", async () => {
    const taskId = await insertTask(pool);
    const txHash = "0x" + "3".repeat(64);
    await insertChainTransaction(pool, taskId, txHash);

    const result = await checkTransactionNotUsed(pool, CHAIN_ID, txHash, taskId);

    expect(result).toEqual({ ok: true });
  });

  it("detects reuse even when the caller submits a mixed-case variant of an already-used hash (Codex round 1 P2)", async () => {
    const taskAId = await insertTask(pool);
    const taskBId = await insertTask(pool);
    // Stored lowercase per chain_transactions_tx_hash_format's CHECK
    // constraint (0005_create_tasks.sql only ever admits `[0-9a-f]`). Uses
    // "5a" (not a bare digit) so `.toUpperCase()` below actually changes
    // the text — an all-digit hash has no case to differ in the first place.
    const lowercaseTxHash = "0x" + "5a".repeat(32);
    await insertChainTransaction(pool, taskAId, lowercaseTxHash);

    // A resubmission with uppercase hex letters — same hash, different text
    // case, exactly what a caller's request body could legitimately send.
    const mixedCaseTxHash = "0x" + "5A".repeat(32);

    const result = await checkTransactionNotUsed(pool, CHAIN_ID, mixedCaseTxHash, taskBId);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRANSACTION_ALREADY_USED");
    expect(result.message).toContain(taskAId);
  });

  it("does not treat the same txHash on a different chainId as already used", async () => {
    const taskAId = await insertTask(pool);
    const taskBId = await insertTask(pool);
    const txHash = "0x" + "4".repeat(64);
    await insertChainTransaction(pool, taskAId, txHash, 1);

    const result = await checkTransactionNotUsed(pool, 2, txHash, taskBId);

    expect(result).toEqual({ ok: true });
  });
});
