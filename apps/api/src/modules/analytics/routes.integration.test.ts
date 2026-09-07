import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { insertInteractionEvent } from "./repository.js";

/**
 * Real-HTTP integration test for T-1901's `POST /analytics/events`
 * (F-1901/F-1902). Skipped unless a human opts in with
 * RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe TEST_DATABASE_URL,
 * same as every other `*.integration.test.ts` suite.
 *
 * Covers: VIEW/CLICK are the only two accepted event types (schema.ts's
 * own closed enum — the other 7 real event types are server-written, never
 * client-reported, see repository.ts's doc comment); an anonymous request
 * (no session cookie) succeeds with `actor_address` left NULL; AC-1902's
 * dedup guarantee holds through this real HTTP endpoint (not just at the
 * repository/SQL layer T-1900 already proved) — a client retrying the same
 * `clientEventId` after a flaky response produces exactly one row.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("POST /analytics/events (integration, T-1901)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM interaction_events");
    await pool.query("DELETE FROM recommendation_candidates");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM users");
  });

  const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";

  /** Seeds a genuine task/agent/run/candidate chain so a test can prove
   * the (runId, agentId) validation accepts a REAL candidate pair, not
   * just reject fabricated ones. */
  async function seedRealCandidate(): Promise<{ taskId: string; agentId: string; runId: string }> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
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
    const taskId = task?.id ?? "";
    const agentId = agent?.id ?? "";
    const {
      rows: [run],
    } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.1', 1, 'digest')
       RETURNING id`,
      [taskId],
    );
    const runId = run?.id ?? "";
    await pool.query(
      `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
       VALUES ($1, $2, 1, 'TOP_SCORE', 1, '[]')`,
      [runId, agentId],
    );
    return { taskId, agentId, runId };
  }

  it("accepts an anonymous VIEW report (no session cookie) and leaves actor_address NULL", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "VIEW",
        sessionId: "session-anon-1",
        clientEventId: "client-event-anon-view",
      },
    });
    expect(response.statusCode).toBe(204);

    const { rows } = await pool.query(
      `SELECT event_type, session_id, actor_address FROM interaction_events WHERE client_event_id = 'client:client-event-anon-view'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "VIEW",
      session_id: "session-anon-1",
      actor_address: null,
    });
  });

  it("accepts a CLICK report with optional taskId/agentId/runId omitted", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "CLICK",
        sessionId: "session-anon-2",
        clientEventId: "client-event-anon-click",
      },
    });
    expect(response.statusCode).toBe(204);

    const { rows } = await pool.query<{ task_id: string | null; agent_id: string | null }>(
      `SELECT task_id, agent_id FROM interaction_events WHERE client_event_id = 'client:client-event-anon-click'`,
    );
    expect(rows[0]?.task_id).toBeNull();
    expect(rows[0]?.agent_id).toBeNull();
  });

  it("rejects an event_type outside the client-reportable VIEW/CLICK closed enum", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "APPROVE",
        sessionId: "session-forge-1",
        clientEventId: "client-event-forge-approve",
      },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'client:client-event-forge-approve'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("N4 P2 fix: rejects a CLICK naming a (runId, agentId) pair that was never a real recommendation candidate together", async () => {
    const { taskId } = await seedRealCandidate();
    const {
      rows: [imposterAgent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Imposter Agent', 'desc', 'writing', $1)
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const { rows: runRows } = await pool.query<{ id: string }>(
      `SELECT id FROM recommendation_runs WHERE task_id = $1`,
      [taskId],
    );
    const realRunId = runRows[0]?.id;

    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "CLICK",
        sessionId: "session-poison-1",
        clientEventId: "client-event-poison",
        taskId,
        runId: realRunId,
        agentId: imposterAgent?.id,
      },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'client:client-event-poison'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("accepts a CLICK naming a real (runId, agentId) recommendation-candidate pair", async () => {
    const { taskId, agentId, runId } = await seedRealCandidate();

    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "CLICK",
        sessionId: "session-real-1",
        clientEventId: "client-event-real",
        taskId,
        runId,
        agentId,
      },
    });
    expect(response.statusCode).toBe(204);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'client:client-event-real'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("N4 P1 fix: a client-submitted clientEventId can never collide with a server-reserved dedup key (e.g. accept:<taskId>)", async () => {
    const taskId = "88888888-8888-8888-8888-888888888888";
    const reservedLookingId = `accept:${taskId}`;

    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "VIEW",
        sessionId: "session-collision-1",
        clientEventId: reservedLookingId,
      },
    });
    expect(response.statusCode).toBe(204);

    // The raw, unprefixed string must never appear as a stored
    // client_event_id — only the namespaced version does — so a real
    // server-side ACCEPT write for the same taskId later cannot collide
    // with it.
    const raw = await pool.query(`SELECT id FROM interaction_events WHERE client_event_id = $1`, [
      reservedLookingId,
    ]);
    expect(raw.rows).toHaveLength(0);

    const namespaced = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = $1`,
      [`client:${reservedLookingId}`],
    );
    expect(namespaced.rows).toHaveLength(1);

    // N4 round 2 (T-1902) re-raised this same concern from the consumer
    // side without visibility into this prefix — end-to-end proof that the
    // REAL server-side ACCEPT write (unprefixed) still succeeds afterward
    // and is NOT silently swallowed by the anonymous submission above.
    await insertInteractionEvent(pool, {
      eventType: "ACCEPT",
      sessionId: `server:${taskId}`,
      clientEventId: reservedLookingId,
      taskId: undefined,
      agentId: undefined,
    });
    const realServerEvent = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM interaction_events WHERE client_event_id = $1`,
      [reservedLookingId],
    );
    expect(realServerEvent.rows).toHaveLength(1);
    expect(realServerEvent.rows[0]?.event_type).toBe("ACCEPT");
  });

  it("N4 P2 fix (widened): rejects agentId submitted without a runId — an Agent association only ever means something in the context of a specific recommendation run", async () => {
    const { taskId, agentId } = await seedRealCandidate();

    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "CLICK",
        sessionId: "session-bypass-1",
        clientEventId: "client-event-bypass",
        taskId,
        agentId,
      },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'client:client-event-bypass'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("N4 P2 fix (widened): rejects a runId whose real task_id doesn't match the caller-supplied taskId", async () => {
    const { runId } = await seedRealCandidate();
    const {
      rows: [otherTask],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Other Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );

    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: {
        eventType: "CLICK",
        sessionId: "session-mismatch-1",
        clientEventId: "client-event-mismatch",
        taskId: otherTask?.id,
        runId,
      },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'client:client-event-mismatch'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("AC-1902: retrying the same clientEventId after a flaky response produces exactly one row", async () => {
    const payload = {
      eventType: "VIEW" as const,
      sessionId: "session-retry-1",
      clientEventId: "client-event-retry",
    };

    const first = await app.inject({ method: "POST", url: "/analytics/events", payload });
    const second = await app.inject({ method: "POST", url: "/analytics/events", payload });
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'client:client-event-retry'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects a malformed body (missing required sessionId)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: { eventType: "VIEW", clientEventId: "client-event-missing-session" },
    });
    expect(response.statusCode).toBe(400);
  });
});
