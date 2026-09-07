import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 21 (arbitration-committee), T-2108 —
 * 0042_create_dispute_evidence_submissions.sql's own real-Postgres
 * verification.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn("0042_create_dispute_evidence_submissions migration (integration, T-2108)", () => {
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
    await pool.query("DELETE FROM dispute_evidence_submissions");
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

  it("accepts multiple real rounds from both real roles for the same dispute, and rejects an invalid role", async () => {
    const disputeId = await insertDispute();
    await pool.query(
      `INSERT INTO dispute_evidence_submissions (dispute_id, submitter_address, submitter_role, content)
       VALUES ($1, $2, 'REQUESTER', 'round 1')`,
      [disputeId, REQUESTER_ADDRESS],
    );
    await pool.query(
      `INSERT INTO dispute_evidence_submissions (dispute_id, submitter_address, submitter_role, content)
       VALUES ($1, $2, 'AGENT', 'round 2')`,
      [disputeId, REQUESTER_ADDRESS],
    );
    const { rows } = await pool.query(
      `SELECT submitter_role, content FROM dispute_evidence_submissions WHERE dispute_id = $1 ORDER BY submitted_at`,
      [disputeId],
    );
    expect(rows).toEqual([
      { submitter_role: "REQUESTER", content: "round 1" },
      { submitter_role: "AGENT", content: "round 2" },
    ]);

    await expect(
      pool.query(
        `INSERT INTO dispute_evidence_submissions (dispute_id, submitter_address, submitter_role, content)
         VALUES ($1, $2, 'BYSTANDER', 'invalid')`,
        [disputeId, REQUESTER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  // N4 real finding (P2, round 1, T-2108): `submitted_at` alone has no
  // deterministic tie-breaker for two rows sharing the same real
  // timestamp — `sequence_no` (a real `BIGSERIAL`, assigned atomically by
  // Postgres itself at INSERT time) is what genuinely orders them.
  it("orders rows by sequence_no, not submitted_at, when two rows share the exact same real timestamp", async () => {
    const disputeId = await insertDispute();
    const sameInstant = new Date().toISOString();
    await pool.query(
      `INSERT INTO dispute_evidence_submissions (dispute_id, submitter_address, submitter_role, content, submitted_at)
       VALUES ($1, $2, 'AGENT', 'second inserted', $3)`,
      [disputeId, REQUESTER_ADDRESS, sameInstant],
    );
    await pool.query(
      `INSERT INTO dispute_evidence_submissions (dispute_id, submitter_address, submitter_role, content, submitted_at)
       VALUES ($1, $2, 'REQUESTER', 'first inserted', $3)`,
      [disputeId, REQUESTER_ADDRESS, sameInstant],
    );
    // Both rows share the identical real `submitted_at` — only
    // `sequence_no` (real INSERT order) can distinguish them.
    const { rows } = await pool.query<{ content: string }>(
      `SELECT content FROM dispute_evidence_submissions WHERE dispute_id = $1 ORDER BY sequence_no`,
      [disputeId],
    );
    expect(rows.map((r) => r.content)).toEqual(["second inserted", "first inserted"]);
  });

  it("rolling back the migration also removes sequence_no's own real BIGSERIAL sequence object", async () => {
    const rollbackPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0042_create_dispute_evidence_submissions.rollback.sql",
    );
    const rollbackSql = readFileSync(rollbackPath, "utf8");
    await pool.query(rollbackSql);

    const { rows: afterDrop } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'dispute_evidence_submissions'`,
    );
    expect(afterDrop).toHaveLength(0);

    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0042_create_dispute_evidence_submissions.sql"]);
  });
});
