import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runFakeDeliveryDetection } from "./detect-fake-delivery.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. F-2007/T-2006's real end-to-end proof: the SAME
// `result_hash` submitted for two real, distinct tasks by the same Agent
// produces exactly one `risk_signals` row and touches no other business
// state.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, " +
  "sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

const OWNER_ADDRESS = "0x" + "d1".repeat(20);
const REQUESTER_ADDRESS = "0x" + "d2".repeat(20);
const TOKEN_ADDRESS = "0x" + "d3".repeat(20);

runIfOptedIn("detect-fake-delivery runFakeDeliveryDetection (integration, T-2006)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    for (const address of [OWNER_ADDRESS, REQUESTER_ADDRESS]) {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [address]);
    }
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM risk_signals");
    await pool.query("DELETE FROM deliverables");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  async function insertAgent(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [OWNER_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertTask(agentId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'RELEASED', $3, 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS, agentId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  async function insertDeliverable(taskId: string, resultHash: string): Promise<void> {
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash)
       VALUES ($1, $2, 'URL', 'https://example.com/x', $3)`,
      [taskId, OWNER_ADDRESS, resultHash],
    );
  }

  it("detects reused delivery content across two real tasks, creates exactly one risk_signals row, and modifies no other business state", async () => {
    const agentId = await insertAgent();
    const taskA = await insertTask(agentId);
    const taskB = await insertTask(agentId);
    const sameHash = "0x" + "a".repeat(64);
    await insertDeliverable(taskA, sameHash);
    await insertDeliverable(taskB, sameHash);

    const before = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
      agentId,
    ]);

    const result = await runFakeDeliveryDetection(pool);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);

    const { rows } = await pool.query<{
      signal_type: string;
      subject_agent_id: string;
      status: string;
      evidence: { duplicateGroups: { resultHash: string; taskIds: string[] }[] };
    }>(`SELECT signal_type, subject_agent_id, status, evidence FROM risk_signals`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signal_type).toBe("FAKE_DELIVERY");
    expect(rows[0]?.subject_agent_id).toBe(agentId);
    expect(rows[0]?.status).toBe("DETECTED");
    expect(rows[0]?.evidence.duplicateGroups).toHaveLength(1);
    expect(rows[0]?.evidence.duplicateGroups[0]?.resultHash).toBe(sameHash);
    expect(rows[0]?.evidence.duplicateGroups[0]?.taskIds.sort()).toEqual([taskA, taskB].sort());

    const after = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
      agentId,
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  it("N4 P1 fix: an Agent with TWO distinct duplicate-hash clusters gets exactly one risk_signals row aggregating both (never silently drops the second)", async () => {
    const agentId = await insertAgent();
    const taskA = await insertTask(agentId);
    const taskB = await insertTask(agentId);
    const taskC = await insertTask(agentId);
    const taskD = await insertTask(agentId);
    const hashOne = "0x" + "1".repeat(64);
    const hashTwo = "0x" + "2".repeat(64);
    await insertDeliverable(taskA, hashOne);
    await insertDeliverable(taskB, hashOne);
    await insertDeliverable(taskC, hashTwo);
    await insertDeliverable(taskD, hashTwo);

    const result = await runFakeDeliveryDetection(pool);
    expect(result.inserted).toBe(1);

    const { rows } = await pool.query<{
      evidence: { duplicateGroups: { resultHash: string }[] };
    }>(`SELECT evidence FROM risk_signals WHERE subject_agent_id = $1`, [agentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidence.duplicateGroups).toHaveLength(2);
    const hashes = rows[0]?.evidence.duplicateGroups.map((g) => g.resultHash).sort();
    expect(hashes).toEqual([hashOne, hashTwo].sort());
  });

  it("does not flag distinct delivery content across different tasks", async () => {
    const agentId = await insertAgent();
    const taskA = await insertTask(agentId);
    const taskB = await insertTask(agentId);
    await insertDeliverable(taskA, "0x" + "b".repeat(64));
    await insertDeliverable(taskB, "0x" + "c".repeat(64));

    const result = await runFakeDeliveryDetection(pool);
    expect(result.inserted).toBe(0);
  });

  it("is idempotent: re-running while a signal is still DETECTED does not create a duplicate", async () => {
    const agentId = await insertAgent();
    const taskA = await insertTask(agentId);
    const taskB = await insertTask(agentId);
    const sameHash = "0x" + "e".repeat(64);
    await insertDeliverable(taskA, sameHash);
    await insertDeliverable(taskB, sameHash);

    const first = await runFakeDeliveryDetection(pool);
    expect(first.inserted).toBe(1);
    const second = await runFakeDeliveryDetection(pool);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);

    const { rows } = await pool.query(`SELECT * FROM risk_signals`);
    expect(rows).toHaveLength(1);
  });

  it("N4-lesson race: two truly concurrent detection runs never both insert a signal for the same Agent", async () => {
    const agentId = await insertAgent();
    const taskA = await insertTask(agentId);
    const taskB = await insertTask(agentId);
    const sameHash = "0x" + "f".repeat(64);
    await insertDeliverable(taskA, sameHash);
    await insertDeliverable(taskB, sameHash);

    const [first, second] = await Promise.all([
      runFakeDeliveryDetection(pool),
      runFakeDeliveryDetection(pool),
    ]);

    const insertedCounts = [first.inserted, second.inserted].sort();
    expect(insertedCounts).toEqual([0, 1]);

    const { rows } = await pool.query(`SELECT id FROM risk_signals WHERE subject_agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
