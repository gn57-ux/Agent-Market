import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 22 (ai-customer-service), T-2200 —
 * 0043_create_kb_articles.sql's own real-Postgres verification.
 *
 * See migrate.integration.test.ts's header comment: skipped unless a human
 * opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
 * TEST_DATABASE_URL.
 *
 * Covers: the table exists with the real column shape design.md's data
 * model requires; `dimension = 1024` CHECK rejects any other value (0017's
 * already-applied localization, NOT 1536); `title` UNIQUE (the natural key
 * kb-repository.ts's upsert relies on); a real round-trip cosine (`<=>`)
 * query against a stored vector returns exact results and no ivfflat
 * index exists (N4 real finding, round 1: an ivfflat index trained on an
 * empty table produces wrong top matches at this table's real scale —
 * see that test's own comment); rollback drops the table, and the
 * migration can be reapplied (up -> down -> up).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function makeVector(dimension: number, seed: number): number[] {
  return Array.from({ length: dimension }, (_, i) => Math.sin(seed + i));
}

runIfOptedIn("kb_articles migration (integration, T-2200)", () => {
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
    await pool.query("DELETE FROM kb_articles");
  });

  it("accepts a well-formed row with a real 1024-dim vector", async () => {
    const vector = makeVector(1024, 1);
    const { rows } = await pool.query<{ id: string; title: string }>(
      `INSERT INTO kb_articles (title, content, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, $3::vector, 'ollama', 'bge-m3:latest', 1024, 'v1')
       RETURNING id, title`,
      ["验收窗口是多久", "验收窗口从提交成果时开始计算", toVectorLiteral(vector)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("验收窗口是多久");
  });

  it("rejects a dimension value other than 1024 (0017's localization, not 1536)", async () => {
    await expect(
      pool.query(
        `INSERT INTO kb_articles (title, content, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, $3::vector, 'openai', 'text-embedding-3-small', 1536, 'v1')`,
        ["bad dimension", "content", toVectorLiteral(makeVector(1024, 2))],
      ),
    ).rejects.toThrow();
  });

  it("allows embedding to be NULL (mid-write state) but rejects a duplicate title", async () => {
    await pool.query(
      `INSERT INTO kb_articles (title, content, provider, model, dimension, embedding_version)
       VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v1')`,
      ["任务取消规则", "占位内容"],
    );
    const { rows } = await pool.query<{ embedding: unknown }>(
      `SELECT embedding FROM kb_articles WHERE title = $1`,
      ["任务取消规则"],
    );
    expect(rows[0]?.embedding).toBeNull();

    await expect(
      pool.query(
        `INSERT INTO kb_articles (title, content, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v1')`,
        ["任务取消规则", "重复标题"],
      ),
    ).rejects.toThrow();
  });

  it("supports a real cosine-distance (<=>) query with exact results (no approximate index)", async () => {
    const closeVector = makeVector(1024, 5);
    const farVector = makeVector(1024, 500);
    await pool.query(
      `INSERT INTO kb_articles (title, content, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, $3::vector, 'ollama', 'bge-m3:latest', 1024, 'v1')`,
      ["close", "close content", toVectorLiteral(closeVector)],
    );
    await pool.query(
      `INSERT INTO kb_articles (title, content, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, $3::vector, 'ollama', 'bge-m3:latest', 1024, 'v1')`,
      ["far", "far content", toVectorLiteral(farVector)],
    );

    const { rows } = await pool.query<{ title: string }>(
      `SELECT title FROM kb_articles ORDER BY embedding <=> $1::vector LIMIT 1`,
      [toVectorLiteral(closeVector)],
    );
    expect(rows[0]?.title).toBe("close");

    // N4 real finding (round 1, T-2200): an ivfflat index built at
    // migration time (an empty table — the migration only just created
    // it) trains degenerate clusters and later returns a WRONG top match
    // at kb_articles's real row count (verified directly: with the index
    // present, a real seeded query nondeterministically returned an
    // unrelated article as the top result). Fixed by never creating an
    // approximate index on this table at all — this assertion guards
    // against it being reintroduced.
    const { rows: indexRows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'kb_articles' AND indexname LIKE '%ivfflat%'`,
    );
    expect(indexRows).toHaveLength(0);
  });

  it("rollback drops the table and index, and the migration can be reapplied (up -> down -> up)", async () => {
    const rollbackPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0043_create_kb_articles.rollback.sql",
    );
    const rollbackSql = readFileSync(rollbackPath, "utf8");
    await pool.query(rollbackSql);

    const { rows: afterDrop } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'kb_articles'`,
    );
    expect(afterDrop).toHaveLength(0);

    const { rows: migrationRows } = await pool.query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id = '0043_create_kb_articles.sql'`,
    );
    expect(migrationRows).toHaveLength(0);

    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0043_create_kb_articles.sql"]);

    const { rows: afterReapply } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'kb_articles'`,
    );
    expect(afterReapply).toHaveLength(1);
  });
});
