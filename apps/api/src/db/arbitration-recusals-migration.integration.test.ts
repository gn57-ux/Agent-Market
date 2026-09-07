import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 21 (arbitration-committee), T-2107 —
 * 0041_create_arbitration_recusals.sql's own real-Postgres verification.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";
const MEMBER_ADDRESS = "0xc283fefc63f0cd0e873a0000c6d07ef7b77e91dc";
const ADMIN_ADDRESS = "0xb283fefc63f0cd0e873a0000c6d07ef7b77e91db";

runIfOptedIn("0041_create_arbitration_recusals migration (integration, T-2107)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM arbitration_recusals");
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM tasks");
  });

  async function insertDispute(): Promise<string> {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 100, $2, now() + interval '7 days', 'DISPUTED', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const taskId = task?.id ?? "";
    const {
      rows: [dispute],
    } = await pool.query<{ id: string }>(
      `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash)
       VALUES ($1, $2, 'reason', 'summary', $3) RETURNING id`,
      [taskId, REQUESTER_ADDRESS, "0x" + "d4".repeat(32)],
    );
    return dispute?.id ?? "";
  }

  it("accepts a real recusal row and rejects a malformed member address", async () => {
    const disputeId = await insertDispute();
    await pool.query(
      `INSERT INTO arbitration_recusals (dispute_id, member_address, reason, recorded_by)
       VALUES ($1, $2, 'conflict of interest', $3)`,
      [disputeId, MEMBER_ADDRESS, ADMIN_ADDRESS],
    );
    const { rows } = await pool.query(`SELECT * FROM arbitration_recusals WHERE dispute_id = $1`, [
      disputeId,
    ]);
    expect(rows).toHaveLength(1);

    await expect(
      pool.query(
        `INSERT INTO arbitration_recusals (dispute_id, member_address, reason, recorded_by)
         VALUES ($1, 'not-an-address', 'x', $2)`,
        [disputeId, ADMIN_ADDRESS],
      ),
    ).rejects.toThrow(/member_address_format/);
  });

  it("rejects the same (dispute, member) recusal being recorded twice", async () => {
    const disputeId = await insertDispute();
    await pool.query(
      `INSERT INTO arbitration_recusals (dispute_id, member_address, reason, recorded_by)
       VALUES ($1, $2, 'conflict of interest', $3)`,
      [disputeId, MEMBER_ADDRESS, ADMIN_ADDRESS],
    );
    await expect(
      pool.query(
        `INSERT INTO arbitration_recusals (dispute_id, member_address, reason, recorded_by)
         VALUES ($1, $2, 'duplicate', $3)`,
        [disputeId, MEMBER_ADDRESS, ADMIN_ADDRESS],
      ),
    ).rejects.toThrow(/unique_dispute_member/);
  });
});
