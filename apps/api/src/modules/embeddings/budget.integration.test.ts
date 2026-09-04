import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { tryConsumeEmbeddingBudget } from "./budget.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1301's own verification that
// `tryConsumeEmbeddingBudget` is genuinely atomic under real concurrency —
// a SELECT-then-UPDATE implementation would let concurrent calls both
// observe "under budget" and both increment, exceeding the ceiling; this
// suite proves the actual `INSERT ... ON CONFLICT DO UPDATE ... WHERE`
// statement this module uses does not have that race.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const ENV_VAR = "EMBEDDING_MONTHLY_BUDGET";

runIfOptedIn("tryConsumeEmbeddingBudget (integration, T-1301)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterEach(async () => {
    delete process.env[ENV_VAR];
    await pool.query("DELETE FROM embedding_budget_usage");
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("succeeds and records exactly one call for the first attempt this month", async () => {
    process.env[ENV_VAR] = "5";
    const ok = await tryConsumeEmbeddingBudget(pool);
    expect(ok).toBe(true);

    const { rows } = await pool.query<{ call_count: number }>(
      `SELECT call_count FROM embedding_budget_usage`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.call_count).toBe(1);
  });

  it("succeeds up to the exact limit, then fails on the next attempt, without incrementing past it", async () => {
    process.env[ENV_VAR] = "3";
    expect(await tryConsumeEmbeddingBudget(pool)).toBe(true);
    expect(await tryConsumeEmbeddingBudget(pool)).toBe(true);
    expect(await tryConsumeEmbeddingBudget(pool)).toBe(true);
    expect(await tryConsumeEmbeddingBudget(pool)).toBe(false);

    const { rows } = await pool.query<{ call_count: number }>(
      `SELECT call_count FROM embedding_budget_usage`,
    );
    // Still exactly 3 — the failed 4th attempt must not have incremented
    // the counter at all (a bug here would silently let the counter drift
    // upward forever even though every call past the limit reports false).
    expect(rows[0]?.call_count).toBe(3);
  });

  it("returns false immediately (0 budget) without ever inserting a row", async () => {
    process.env[ENV_VAR] = "0";
    const ok = await tryConsumeEmbeddingBudget(pool);
    expect(ok).toBe(false);

    const { rows } = await pool.query(`SELECT * FROM embedding_budget_usage`);
    expect(rows).toHaveLength(0);
  });

  // The core atomicity proof: real concurrent calls, not sequential awaits
  // — a SELECT-then-UPDATE implementation would let more than `limit` calls
  // all observe "under budget" simultaneously and all succeed, overshooting
  // the ceiling. This fires 10 genuinely concurrent calls against a limit
  // of 4 and asserts exactly 4 succeed.
  it("real concurrency: of 10 simultaneous calls against a limit of 4, exactly 4 succeed", async () => {
    process.env[ENV_VAR] = "4";
    const results = await Promise.all(
      Array.from({ length: 10 }, () => tryConsumeEmbeddingBudget(pool)),
    );
    const succeeded = results.filter(Boolean).length;
    expect(succeeded).toBe(4);

    const { rows } = await pool.query<{ call_count: number }>(
      `SELECT call_count FROM embedding_budget_usage`,
    );
    expect(rows[0]?.call_count).toBe(4);
  });
});
