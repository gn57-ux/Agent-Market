import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 22 (ai-customer-service), T-2204 —
 * 0044_create_customer_service_conversations.sql's own real-Postgres
 * verification. Skipped unless a human opts in with
 * RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe TEST_DATABASE_URL
 * (same convention as kb-articles-migration.integration.test.ts).
 *
 * Covers: real column shapes; the `role` CHECK closed to
 * USER/ASSISTANT/HUMAN_AGENT; the `actor_address` format CHECK (nullable);
 * cascade delete (removing a conversation removes its messages); rollback
 * drops both tables and the migration can be reapplied (up -> down -> up).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("customer_service_conversations/messages migration (integration, T-2204)", () => {
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
    await pool.query("DELETE FROM customer_service_conversations");
  });

  it("accepts a well-formed anonymous conversation (actor_address NULL)", async () => {
    const { rows } = await pool.query<{ id: string; actor_address: string | null }>(
      `INSERT INTO customer_service_conversations (session_id)
       VALUES ('anon-session-1')
       RETURNING id, actor_address`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_address).toBeNull();
  });

  it("rejects a malformed actor_address (fails the format CHECK)", async () => {
    await expect(
      pool.query(
        `INSERT INTO customer_service_conversations (session_id, actor_address)
         VALUES ('s', 'not-an-address')`,
      ),
    ).rejects.toThrow();
  });

  it("accepts a well-formed lowercase actor_address", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customer_service_conversations (session_id, actor_address)
       VALUES ('s', '0x1111111111111111111111111111111111111111')
       RETURNING id`,
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects a message role outside USER/ASSISTANT/HUMAN_AGENT", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customer_service_conversations (session_id) VALUES ('s') RETURNING id`,
    );
    const conversationId = rows[0]?.id;
    await expect(
      pool.query(
        `INSERT INTO customer_service_messages (conversation_id, role, content)
         VALUES ($1, 'SYSTEM', 'x')`,
        [conversationId],
      ),
    ).rejects.toThrow();
  });

  it("accepts each of the three real roles and stores cited_kb_article_ids", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customer_service_conversations (session_id) VALUES ('s') RETURNING id`,
    );
    const conversationId = rows[0]?.id;
    const articleId = "11111111-1111-4111-8111-111111111111";

    for (const role of ["USER", "ASSISTANT", "HUMAN_AGENT"]) {
      await pool.query(
        `INSERT INTO customer_service_messages (conversation_id, role, content, cited_kb_article_ids)
         VALUES ($1, $2, 'content', $3)`,
        [conversationId, role, role === "ASSISTANT" ? [articleId] : null],
      );
    }

    const { rows: messages } = await pool.query<{
      role: string;
      cited_kb_article_ids: string[] | null;
    }>(
      `SELECT role, cited_kb_article_ids FROM customer_service_messages WHERE conversation_id = $1 ORDER BY role`,
      [conversationId],
    );
    expect(messages).toHaveLength(3);
    const assistantRow = messages.find((m) => m.role === "ASSISTANT");
    expect(assistantRow?.cited_kb_article_ids).toEqual([articleId]);
  });

  it("cascade delete: removing a conversation removes its messages", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customer_service_conversations (session_id) VALUES ('s') RETURNING id`,
    );
    const conversationId = rows[0]?.id;
    await pool.query(
      `INSERT INTO customer_service_messages (conversation_id, role, content) VALUES ($1, 'USER', 'hi')`,
      [conversationId],
    );

    await pool.query(`DELETE FROM customer_service_conversations WHERE id = $1`, [conversationId]);

    const { rows: remaining } = await pool.query(
      `SELECT id FROM customer_service_messages WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(remaining).toHaveLength(0);
  });

  it("rollback drops both tables, and the migration can be reapplied (up -> down -> up)", async () => {
    const rollbackPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0044_create_customer_service_conversations.rollback.sql",
    );
    const rollbackSql = readFileSync(rollbackPath, "utf8");
    await pool.query(rollbackSql);

    const { rows: afterDrop } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('customer_service_conversations', 'customer_service_messages')`,
    );
    expect(afterDrop).toHaveLength(0);

    const { rows: migrationRows } = await pool.query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id = '0044_create_customer_service_conversations.sql'`,
    );
    expect(migrationRows).toHaveLength(0);

    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0044_create_customer_service_conversations.sql"]);

    const { rows: afterReapply } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('customer_service_conversations', 'customer_service_messages')`,
    );
    expect(afterReapply).toHaveLength(2);
  });
});
