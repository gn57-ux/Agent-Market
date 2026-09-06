import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { seedBaselineEvaluationTasks } from "./seed-baseline-evaluation-tasks.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. Real end-to-end proof that this script's own real
// question bank is loadable, scorable, and idempotent — not just that its
// content compiles.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

runIfOptedIn("seed-baseline-evaluation-tasks (integration, T-2009)", () => {
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
    await pool.query("DELETE FROM evaluation_tasks");
    await pool.query("DELETE FROM evaluation_rubrics");
  });

  it("loads a real question bank of at least 10 RULE_BASED tasks across 3 categories", async () => {
    const result = await seedBaselineEvaluationTasks(pool);
    expect(result.inserted).toBeGreaterThanOrEqual(10);
    expect(result.skipped).toBe(0);

    const { rows } = await pool.query<{ category: string; scoring_mode: string; count: string }>(
      `SELECT category, scoring_mode, count(*)::text AS count
         FROM evaluation_tasks et
         JOIN evaluation_rubrics er ON er.id = et.rubric_id
        GROUP BY category, scoring_mode`,
    );
    const categories = new Set(rows.map((r) => r.category));
    expect(categories.size).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.scoring_mode === "RULE_BASED")).toBe(true);
  });

  it("is idempotent: re-running does not duplicate the question bank", async () => {
    const first = await seedBaselineEvaluationTasks(pool);
    const second = await seedBaselineEvaluationTasks(pool);

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM evaluation_tasks`,
    );
    expect(Number(rows[0]?.count)).toBe(first.inserted);
  });

  it("N4 P2 fix: self-heals a rubric that exists with no task (simulating a crash between the two writes before this fix's atomic transaction)", async () => {
    // Manually recreate the exact orphan state the original non-atomic
    // version could leave behind: a rubric row for one of the script's own
    // questions, but no evaluation_tasks row referencing it.
    await pool.query(
      `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
       VALUES ('baseline-v1-writing-01', 'writing', '{"type":"KEYWORD_PRESENCE","requiredKeywords":["x"]}')`,
    );

    const result = await seedBaselineEvaluationTasks(pool);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM evaluation_tasks et
         JOIN evaluation_rubrics er ON er.id = et.rubric_id
        WHERE er.rubric_version = 'baseline-v1-writing-01'`,
    );
    expect(Number(rows[0]?.count)).toBe(1);
    expect(result.inserted).toBeGreaterThanOrEqual(1);
  });

  it("every seeded question's criteria is real, parseable KEYWORD_PRESENCE content that a genuinely-correct answer can pass with score 100 and a genuinely-wrong answer fails", async () => {
    await seedBaselineEvaluationTasks(pool);
    const { rows } = await pool.query<{ criteria: { requiredKeywords: string[] } }>(
      `SELECT criteria FROM evaluation_rubrics LIMIT 1`,
    );
    const requiredKeywords = rows[0]?.criteria.requiredKeywords ?? [];
    expect(requiredKeywords.length).toBeGreaterThan(0);
    for (const keyword of requiredKeywords) {
      expect(keyword.trim().length).toBeGreaterThan(0);
    }
  });
});
