import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runCollusionDetection } from "./detect-collusion.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. F-2008/T-2006's real end-to-end proof: the SAME
// (requester, Agent) pair completing 5+ real, distinct tasks all rated 5
// produces exactly one `risk_signals` row and touches no other business
// state.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const OWNER_ADDRESS = "0x" + "e1".repeat(20);
const REQUESTER_ADDRESS = "0x" + "e2".repeat(20);
const OTHER_REQUESTER_ADDRESS = "0x" + "e3".repeat(20);
const TOKEN_ADDRESS = "0x" + "e4".repeat(20);

runIfOptedIn("detect-collusion runCollusionDetection (integration, T-2006)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    for (const address of [OWNER_ADDRESS, REQUESTER_ADDRESS, OTHER_REQUESTER_ADDRESS]) {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [address]);
    }
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM risk_signals");
    await pool.query("DELETE FROM ratings");
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

  async function insertRatedTask(
    agentId: string,
    requesterAddress: string,
    score: number,
  ): Promise<string> {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'RELEASED', $3, 'AUTOMATION')
       RETURNING id`,
      [requesterAddress, TOKEN_ADDRESS, agentId],
    );
    const taskId = task?.id;
    if (!taskId) throw new Error("insertRatedTask: no task id returned");
    await pool.query(
      `INSERT INTO ratings (task_id, requester_address, score) VALUES ($1, $2, $3)`,
      [taskId, requesterAddress, score],
    );
    return taskId;
  }

  it("detects a real 串谋 pattern (5+ tasks, same pair, all high scores), creates exactly one risk_signals row, and modifies no other business state", async () => {
    const agentId = await insertAgent();
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      taskIds.push(await insertRatedTask(agentId, REQUESTER_ADDRESS, 5));
    }

    const before = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
      agentId,
    ]);

    const result = await runCollusionDetection(pool);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);

    const { rows } = await pool.query<{
      signal_type: string;
      subject_agent_id: string;
      status: string;
      evidence: { suspiciousPairs: { requesterAddress: string; taskIds: string[] }[] };
    }>(`SELECT signal_type, subject_agent_id, status, evidence FROM risk_signals`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signal_type).toBe("COLLUSION");
    expect(rows[0]?.subject_agent_id).toBe(agentId);
    expect(rows[0]?.evidence.suspiciousPairs).toHaveLength(1);
    expect(rows[0]?.evidence.suspiciousPairs[0]?.requesterAddress).toBe(REQUESTER_ADDRESS);
    expect(rows[0]?.evidence.suspiciousPairs[0]?.taskIds.sort()).toEqual([...taskIds].sort());

    const after = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
      agentId,
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  it("N4 P1 fix: an Agent colluding with TWO distinct requesters gets exactly one risk_signals row aggregating both pairs (never silently drops the second)", async () => {
    const agentId = await insertAgent();
    for (let i = 0; i < 5; i++) {
      await insertRatedTask(agentId, REQUESTER_ADDRESS, 5);
    }
    for (let i = 0; i < 5; i++) {
      await insertRatedTask(agentId, OTHER_REQUESTER_ADDRESS, 5);
    }

    const result = await runCollusionDetection(pool);
    expect(result.inserted).toBe(1);

    const { rows } = await pool.query<{
      evidence: { suspiciousPairs: { requesterAddress: string }[] };
    }>(`SELECT evidence FROM risk_signals WHERE subject_agent_id = $1`, [agentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidence.suspiciousPairs).toHaveLength(2);
    const requesters = rows[0]?.evidence.suspiciousPairs.map((p) => p.requesterAddress).sort();
    expect(requesters).toEqual([REQUESTER_ADDRESS, OTHER_REQUESTER_ADDRESS].sort());
  });

  it("does not flag a normal spread of requesters rating one Agent highly", async () => {
    const agentId = await insertAgent();
    await insertRatedTask(agentId, REQUESTER_ADDRESS, 5);
    await insertRatedTask(agentId, OTHER_REQUESTER_ADDRESS, 5);

    const result = await runCollusionDetection(pool);
    expect(result.inserted).toBe(0);
  });

  it("is idempotent: re-running while a signal is still DETECTED does not create a duplicate", async () => {
    const agentId = await insertAgent();
    for (let i = 0; i < 5; i++) {
      await insertRatedTask(agentId, REQUESTER_ADDRESS, 5);
    }

    const first = await runCollusionDetection(pool);
    expect(first.inserted).toBe(1);
    const second = await runCollusionDetection(pool);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);

    const { rows } = await pool.query(`SELECT * FROM risk_signals`);
    expect(rows).toHaveLength(1);
  });

  it("N4-lesson race: two truly concurrent detection runs never both insert a signal for the same Agent", async () => {
    const agentId = await insertAgent();
    for (let i = 0; i < 5; i++) {
      await insertRatedTask(agentId, REQUESTER_ADDRESS, 5);
    }

    const [first, second] = await Promise.all([
      runCollusionDetection(pool),
      runCollusionDetection(pool),
    ]);

    const insertedCounts = [first.inserted, second.inserted].sort();
    expect(insertedCounts).toEqual([0, 1]);

    const { rows } = await pool.query(`SELECT id FROM risk_signals WHERE subject_agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
