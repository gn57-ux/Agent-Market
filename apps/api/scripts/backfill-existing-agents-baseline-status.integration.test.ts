import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { backfillExistingAgentsBaselineStatus } from "./backfill-existing-agents-baseline-status.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

const OWNER_ADDRESS = "0x" + "f1".repeat(20);

runIfOptedIn("backfill-existing-agents-baseline-status (integration, T-2009)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agents");
  });

  async function insertAgent(baselineStatus?: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      baselineStatus
        ? `INSERT INTO agents (owner_address, name, description, category, payout_address, baseline_evaluation_status)
           VALUES ($1, 'Agent', 'desc', 'writing', $1, $2) RETURNING id`
        : `INSERT INTO agents (owner_address, name, description, category, payout_address)
           VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      baselineStatus ? [OWNER_ADDRESS, baselineStatus] : [OWNER_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  it("grandfathers every NOT_STARTED Agent to PASSED", async () => {
    const agentId = await insertAgent();
    const result = await backfillExistingAgentsBaselineStatus(pool);
    expect(result.updated).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ baseline_evaluation_status: string }>(
      `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.baseline_evaluation_status).toBe("PASSED");
  });

  it("never touches an Agent that already has a real PENDING/PASSED/FAILED status", async () => {
    const pendingAgent = await insertAgent("PENDING");
    const failedAgent = await insertAgent("FAILED");

    await backfillExistingAgentsBaselineStatus(pool);

    const { rows } = await pool.query<{ id: string; baseline_evaluation_status: string }>(
      `SELECT id, baseline_evaluation_status FROM agents WHERE id = ANY($1)`,
      [[pendingAgent, failedAgent]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.baseline_evaluation_status]));
    expect(byId.get(pendingAgent)).toBe("PENDING");
    expect(byId.get(failedAgent)).toBe("FAILED");
  });

  it("is idempotent: re-running after the first pass updates nothing further", async () => {
    await insertAgent();
    await backfillExistingAgentsBaselineStatus(pool);
    const second = await backfillExistingAgentsBaselineStatus(pool);
    expect(second.updated).toBe(0);
  });
});
