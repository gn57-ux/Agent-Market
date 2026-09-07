import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1900's own dedicated verification that
// 0035_create_interaction_events.sql actually enforces, at the database
// layer, F-1901's closed 9-event-type enum and F-1902/AC-1902's dedup
// guarantee — this Task's own scope is the migration only (no
// application-layer collection endpoint yet, that is T-1901's separate
// scope), so the dedup pattern a real caller will use
// (`ON CONFLICT (client_event_id) DO NOTHING`) is exercised here directly
// against the schema, not through a repository function that doesn't
// exist yet.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

runIfOptedIn("interaction_events migration (integration, T-1900)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("accepts each of the 9 real event types, with only session_id/event_type/client_event_id required", async () => {
    const eventTypes = [
      "EXPOSURE",
      "VIEW",
      "CLICK",
      "ACCEPT",
      "SUBMIT",
      "APPROVE",
      "RATE",
      "REFUND",
      "DISPUTE",
    ];
    for (const eventType of eventTypes) {
      const { rows } = await pool.query<{ id: string; occurred_at: Date }>(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id)
         VALUES ($1, 'session-1', $2)
         RETURNING id, occurred_at`,
        [eventType, `client-event-${eventType}`],
      );
      expect(rows[0]?.id).toBeTruthy();
      expect(rows[0]?.occurred_at).toBeInstanceOf(Date);
    }
  });

  it("rejects an event_type outside the 9-value closed enum", async () => {
    await expect(
      pool.query(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id)
         VALUES ('NOT_A_REAL_EVENT', 'session-1', 'client-event-bad-type')`,
      ),
    ).rejects.toThrow(/interaction_events_event_type_check/);
  });

  it("AC-1902: a plain duplicate client_event_id (no ON CONFLICT) is rejected by the UNIQUE constraint", async () => {
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id)
       VALUES ('EXPOSURE', 'session-2', 'dup-event-1')`,
    );
    await expect(
      pool.query(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id)
         VALUES ('EXPOSURE', 'session-2', 'dup-event-1')`,
      ),
    ).rejects.toThrow(/interaction_events_client_event_id_key/);
  });

  it("AC-1902: the real dedup pattern (ON CONFLICT (client_event_id) DO NOTHING) makes a duplicate submission a safe no-op — only one row exists after two identical inserts", async () => {
    const insertOnce = () =>
      pool.query(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id)
         VALUES ('EXPOSURE', 'session-3', 'dup-event-2')
         ON CONFLICT (client_event_id) DO NOTHING`,
      );
    await insertOnce();
    await insertOnce();

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'dup-event-2'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("task_id/agent_id/run_id are all nullable — an event with none of them still inserts", async () => {
    const { rows } = await pool.query<{
      task_id: string | null;
      agent_id: string | null;
      run_id: string | null;
    }>(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id)
       VALUES ('VIEW', 'session-4', 'client-event-no-refs')
       RETURNING task_id, agent_id, run_id`,
    );
    expect(rows[0]?.task_id).toBeNull();
    expect(rows[0]?.agent_id).toBeNull();
    expect(rows[0]?.run_id).toBeNull();
  });
});
