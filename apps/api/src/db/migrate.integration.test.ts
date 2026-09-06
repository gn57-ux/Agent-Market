import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

// These tests execute real DDL (CREATE TABLE / CREATE INDEX) against a real
// PostgreSQL database. Per this session's policy, migration execution is
// treated as a high-risk operation that needs explicit human confirmation
// of the target database before running — so this suite is skipped unless
// a human opts in with RUN_DB_INTEGRATION_TESTS=1 and TEST_DATABASE_URL
// pointing at a database they've confirmed is safe to write to (a dedicated
// local throwaway/test database — see test-support.ts's
// requireTestDatabaseUrl for why this must be a separate variable from the
// app's normal DATABASE_URL, and why the database name itself is checked).
//
// `pnpm --filter @agent-market/api test` therefore reports these as SKIPPED
// by default on a machine that hasn't set TEST_DATABASE_URL — that's
// intentional (no destructive DDL runs without explicit opt-in), not
// evidence these are unverified: see the T-403 handoff report for the run
// used to actually verify this suite end to end.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

runIfOptedIn("runMigrations (integration)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("applies all migrations on first run", async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual([
      "0001_create_users.sql",
      "0002_create_auth_nonces.sql",
      "0003_create_sessions.sql",
      "0004_create_agents.sql",
      "0005_create_tasks.sql",
      "0006_add_dispatch_matching_fields.sql",
      "0007_create_recommendation_tables.sql",
      "0008_create_acceptance_permits.sql",
      "0009_create_deliverables.sql",
      "0010_create_pending_result_submissions.sql",
      "0011_create_disputes.sql",
      "0012_create_ratings.sql",
      "0013_add_agent_task_credentials.sql",
      "0014_drop_expert_type_default.sql",
      "0015_create_vector_recall_scoring.sql",
      "0016_create_embedding_budget.sql",
      "0017_ollama_embedding_dimension.sql",
      "0018_create_consumed_privy_tokens.sql",
      "0019_add_agent_review_status.sql",
      "0020_create_admin_roles.sql",
      "0021_create_task_dags.sql",
      "0022_add_task_dag_node_expert_fields.sql",
      "0023_add_task_dag_category_and_node_description.sql",
      "0024_add_task_dag_node_title_and_deadline.sql",
      "0025_make_task_dag_node_description_nullable.sql",
      "0026_add_task_dag_node_selected_predecessors.sql",
      "0027_create_outbox_events.sql",
      "0028_create_chain_indexed_events.sql",
      "0029_create_processed_events.sql",
      "0030_create_indexer_scan_checkpoints.sql",
      "0031_create_evaluation_tables.sql",
      "0032_add_agents_baseline_evaluation_status.sql",
      "0033_add_risk_signals_one_open_per_subject.sql",
      "0034_add_agents_risk_hold_status.sql",
      "0035_create_interaction_events.sql",
      "0036_create_ctr_training_datasets.sql",
      "0037_create_ctr_models_and_rerank_observability.sql",
      "0038_add_ctr_models_fusion_weights.sql",
    ]);
    expect(result.alreadyApplied).toEqual([]);

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN ('users', 'auth_nonces', 'sessions', 'agents', 'agent_skills',
         'tasks', 'task_skills', 'chain_transactions', 'chain_events', 'task_state_history',
         'blocked_wallets', 'recommendation_runs', 'recommendation_candidates',
         'acceptance_permits', 'deliverables', 'pending_result_submissions', 'disputes',
         'audit_logs', 'ratings', 'agent_embeddings', 'task_embeddings', 'embedding_budget_usage',
         'consumed_privy_tokens', 'agent_review_audit_logs', 'admin_roles', 'admin_role_audit_logs', 'task_dags', 'task_dag_nodes', 'task_dag_edges', 'task_dag_node_skills')`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([
      "acceptance_permits",
      "admin_role_audit_logs",
      "admin_roles",
      "agent_embeddings",
      "agent_review_audit_logs",
      "agent_skills",
      "agents",
      "audit_logs",
      "auth_nonces",
      "blocked_wallets",
      "chain_events",
      "chain_transactions",
      "consumed_privy_tokens",
      "deliverables",
      "disputes",
      "embedding_budget_usage",
      "pending_result_submissions",
      "ratings",
      "recommendation_candidates",
      "recommendation_runs",
      "sessions",
      "task_dag_edges",
      "task_dag_node_skills",
      "task_dag_nodes",
      "task_dags",
      "task_embeddings",
      "task_skills",
      "task_state_history",
      "tasks",
      "users",
    ]);
  });

  it("is a no-op / does not fail when run again (idempotent)", async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual([
      "0001_create_users.sql",
      "0002_create_auth_nonces.sql",
      "0003_create_sessions.sql",
      "0004_create_agents.sql",
      "0005_create_tasks.sql",
      "0006_add_dispatch_matching_fields.sql",
      "0007_create_recommendation_tables.sql",
      "0008_create_acceptance_permits.sql",
      "0009_create_deliverables.sql",
      "0010_create_pending_result_submissions.sql",
      "0011_create_disputes.sql",
      "0012_create_ratings.sql",
      "0013_add_agent_task_credentials.sql",
      "0014_drop_expert_type_default.sql",
      "0015_create_vector_recall_scoring.sql",
      "0016_create_embedding_budget.sql",
      "0017_ollama_embedding_dimension.sql",
      "0018_create_consumed_privy_tokens.sql",
      "0019_add_agent_review_status.sql",
      "0020_create_admin_roles.sql",
      "0021_create_task_dags.sql",
      "0022_add_task_dag_node_expert_fields.sql",
      "0023_add_task_dag_category_and_node_description.sql",
      "0024_add_task_dag_node_title_and_deadline.sql",
      "0025_make_task_dag_node_description_nullable.sql",
      "0026_add_task_dag_node_selected_predecessors.sql",
      "0027_create_outbox_events.sql",
      "0028_create_chain_indexed_events.sql",
      "0029_create_processed_events.sql",
      "0030_create_indexer_scan_checkpoints.sql",
      "0031_create_evaluation_tables.sql",
      "0032_add_agents_baseline_evaluation_status.sql",
      "0033_add_risk_signals_one_open_per_subject.sql",
      "0034_add_agents_risk_hold_status.sql",
      "0035_create_interaction_events.sql",
      "0036_create_ctr_training_datasets.sql",
      "0037_create_ctr_models_and_rerank_observability.sql",
      "0038_add_ctr_models_fusion_weights.sql",
    ]);
  });
});
