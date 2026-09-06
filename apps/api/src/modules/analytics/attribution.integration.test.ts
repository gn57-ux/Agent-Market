import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { findAttributedOutcomes } from "./attribution.js";
import { insertInteractionEvent } from "./repository.js";

/**
 * Real-Postgres integration test for T-1902's `findAttributedOutcomes` —
 * proves the DB query wrapper around `isAttributedEvent` (already unit
 * tested in attribution.test.ts) correctly restricts to real rows for the
 * right task, excludes other EXPOSURE rows, and respects the time window
 * against genuine `TIMESTAMPTZ` values (not just constructed `Date`s).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";

runIfOptedIn("findAttributedOutcomes (integration, T-1902)", () => {
  let pool: Pool;
  let taskId: string;
  let agentId: string;

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
    await pool.query("DELETE FROM interaction_events");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  async function seed(): Promise<void> {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Test Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const {
      rows: [agent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Test Agent', 'desc', 'writing', $1)
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    taskId = task?.id ?? "";
    agentId = agent?.id ?? "";
  }

  async function seedRun(): Promise<string> {
    const {
      rows: [run],
    } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.1', 1, 'digest')
       RETURNING id`,
      [taskId],
    );
    return run?.id ?? "";
  }

  async function insertAt(
    eventType: string,
    clientEventId: string,
    occurredAt: string,
    withAgent = true,
    runId?: string,
  ): Promise<string> {
    await insertInteractionEvent(pool, {
      eventType,
      sessionId: `server:${taskId}`,
      clientEventId,
      taskId,
      agentId: withAgent ? agentId : undefined,
      runId,
    });
    await pool.query(`UPDATE interaction_events SET occurred_at = $1 WHERE client_event_id = $2`, [
      occurredAt,
      clientEventId,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM interaction_events WHERE client_event_id = $1`,
      [clientEventId],
    );
    return rows[0]?.id ?? "";
  }

  it("returns a real ACCEPT within the window and excludes a later, out-of-window RATE", async () => {
    await seed();
    const exposureId = await insertAt("EXPOSURE", "exposure-1", "2026-09-01T00:00:00.000Z");
    await insertAt("ACCEPT", "accept-1", "2026-09-02T00:00:00.000Z");
    await insertAt(
      "RATE",
      "rate-1",
      new Date(
        new Date("2026-09-01T00:00:00.000Z").getTime() + 8 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );

    const outcomes = await findAttributedOutcomes(pool, exposureId);
    expect(outcomes.map((o) => o.eventType)).toEqual(["ACCEPT"]);
  });

  it("excludes a later EXPOSURE row (a re-run of matching is not an outcome)", async () => {
    await seed();
    const exposureId = await insertAt("EXPOSURE", "exposure-2", "2026-09-01T00:00:00.000Z");
    await insertAt("EXPOSURE", "exposure-3", "2026-09-01T01:00:00.000Z");

    const outcomes = await findAttributedOutcomes(pool, exposureId);
    expect(outcomes).toHaveLength(0);
  });

  it("returns an empty list for a non-EXPOSURE event id", async () => {
    await seed();
    const acceptId = await insertAt("ACCEPT", "accept-2", "2026-09-01T00:00:00.000Z");

    const outcomes = await findAttributedOutcomes(pool, acceptId);
    expect(outcomes).toHaveLength(0);
  });

  it("N4 P1 fix: excludes a CLICK with no runId (a stranger who never received this real recommendation) even for the same task+agent within window", async () => {
    await seed();
    const runId = await seedRun();
    const exposureId = await insertAt(
      "EXPOSURE",
      "exposure-strangers",
      "2026-09-01T00:00:00.000Z",
      true,
      runId,
    );
    await insertAt("CLICK", "click-stranger", "2026-09-01T00:05:00.000Z");

    const outcomes = await findAttributedOutcomes(pool, exposureId);
    expect(outcomes).toHaveLength(0);
  });

  it("includes a CLICK carrying the real matching runId", async () => {
    await seed();
    const runId = await seedRun();
    const exposureId = await insertAt(
      "EXPOSURE",
      "exposure-real",
      "2026-09-01T00:00:00.000Z",
      true,
      runId,
    );
    await insertAt("CLICK", "click-real", "2026-09-01T00:05:00.000Z", true, runId);

    const outcomes = await findAttributedOutcomes(pool, exposureId);
    expect(outcomes.map((o) => o.eventType)).toEqual(["CLICK"]);
  });

  it("N4 P1 fix: an agent-less REFUND (pre-acceptance cancellation) is not attributed to the candidate's exposure", async () => {
    await seed();
    const exposureId = await insertAt("EXPOSURE", "exposure-refund", "2026-09-01T00:00:00.000Z");
    await insertAt("REFUND", "refund-1", "2026-09-02T00:00:00.000Z", false);

    const outcomes = await findAttributedOutcomes(pool, exposureId);
    expect(outcomes).toHaveLength(0);
  });
});
