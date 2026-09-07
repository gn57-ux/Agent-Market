import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { getOutboxEventById, writeOutboxEvent } from "../outbox/repository.js";
import {
  applyInteractionEventOutboxPayload,
  buildInteractionEventOutboxInput,
  serverSessionId,
  writeInteractionEventToOutbox,
} from "./outbox-event.js";

/**
 * Real-Postgres integration test for T-1901's write/consume mapping
 * between a server-originated interaction event and `outbox_events`.
 * Skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1, same as
 * every other `*.integration.test.ts` suite.
 *
 * This is deliberately NOT an end-to-end "drive the real HTTP task
 * lifecycle" test — that's covered by the extended assertions added to
 * each business endpoint's own existing lifecycle test (acceptance/
 * result-submission/settlement/ratings/disputes). This suite instead
 * proves the one piece of logic unique to this Task: the outbox payload
 * this module builds really does round-trip into a correct
 * `interaction_events` row once "relayed" (T-1801/T-1802 already proved
 * the relay/queue/idempotent-consumption mechanism itself works — this
 * Task reuses that mechanism rather than re-verifying it).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

runIfOptedIn("interaction-event outbox write/consume mapping (integration, T-1901)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";

  /** `interaction_events.task_id`/`agent_id` are real FKs (T-1900) —
   * every test below needs a genuine `tasks`/`agents` row to point at,
   * not an arbitrary UUID. */
  async function seedTaskAndAgent(taskId: string, agentId: string): Promise<void> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
    await pool.query(
      `INSERT INTO tasks (id, requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, $2, 'writing', 'Test Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'OPEN', 'AUTOMATION')`,
      [taskId, REQUESTER_ADDRESS],
    );
    await pool.query(
      `INSERT INTO agents (id, owner_address, name, description, category, payout_address)
       VALUES ($1, $2, 'Test Agent', 'desc', 'writing', $2)`,
      [agentId, REQUESTER_ADDRESS],
    );
  }

  afterEach(async () => {
    await pool.query("DELETE FROM outbox_events");
    await pool.query("DELETE FROM interaction_events");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM users");
  });

  it("writeInteractionEventToOutbox writes a real outbox_events row whose payload round-trips through applyInteractionEventOutboxPayload into a correct interaction_events row", async () => {
    const taskId = "11111111-1111-1111-1111-111111111111";
    const agentId = "22222222-2222-2222-2222-222222222222";
    await seedTaskAndAgent(taskId, agentId);

    const client = await pool.connect();
    let outboxId: string;
    try {
      await client.query("BEGIN");
      await writeInteractionEventToOutbox(client, {
        eventType: "ACCEPT",
        sessionId: serverSessionId(taskId),
        clientEventId: `accept:${taskId}`,
        taskId,
        agentId,
        actorAddress: "0xabc0000000000000000000000000000000000a",
      });
      const outboxRow = await client.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE aggregate_id = $1`,
        [taskId],
      );
      outboxId = outboxRow.rows[0]?.id ?? "";
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(outboxId).not.toBe("");
    const outboxEvent = await getOutboxEventById(pool, outboxId);
    expect(outboxEvent?.aggregateType).toBe("task");
    expect(outboxEvent?.eventType).toBe("ACCEPT");

    const applied = await applyInteractionEventOutboxPayload(pool, outboxEvent?.payload);
    expect(applied).toBe(true);

    const { rows } = await pool.query(
      `SELECT event_type, session_id, task_id, agent_id, actor_address FROM interaction_events WHERE client_event_id = $1`,
      [`accept:${taskId}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "ACCEPT",
      session_id: `server:${taskId}`,
      task_id: taskId,
      agent_id: agentId,
      actor_address: "0xabc0000000000000000000000000000000000a",
    });
  });

  it("applyInteractionEventOutboxPayload is a no-op (returns false) for a payload that isn't shaped like an interaction event", async () => {
    const client = await pool.connect();
    let outboxId: string;
    try {
      await client.query("BEGIN");
      outboxId = await writeOutboxEvent(client, {
        aggregateType: "some_other_future_feature",
        aggregateId: "33333333-3333-3333-3333-333333333333",
        eventType: "SOMETHING_ELSE",
        payload: { totallyUnrelated: true },
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const outboxEvent = await getOutboxEventById(pool, outboxId);
    const applied = await applyInteractionEventOutboxPayload(pool, outboxEvent?.payload);
    expect(applied).toBe(false);

    const { rows } = await pool.query(`SELECT id FROM interaction_events`);
    expect(rows).toHaveLength(0);
  });

  it("a duplicate relay of the same outbox row (simulated at-least-once redelivery) is a safe no-op via client_event_id's UNIQUE constraint", async () => {
    const taskId = "44444444-4444-4444-4444-444444444444";
    const agentId = "55555555-5555-5555-5555-555555555555";
    await seedTaskAndAgent(taskId, agentId);

    const input = buildInteractionEventOutboxInput({
      eventType: "SUBMIT",
      sessionId: serverSessionId(taskId),
      clientEventId: `submit:${taskId}`,
      taskId,
      agentId,
    });

    await applyInteractionEventOutboxPayload(pool, input.payload);
    await applyInteractionEventOutboxPayload(pool, input.payload);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = $1`,
      [`submit:${taskId}`],
    );
    expect(rows).toHaveLength(1);
  });

  it("N4 P2 fix (round 2): rejects a shape-valid but semantically-empty EXPOSURE (missing taskId/agentId/runId) instead of inserting a permanently useless row", async () => {
    const applied = await applyInteractionEventOutboxPayload(pool, {
      kind: "interaction_event",
      eventType: "EXPOSURE",
      sessionId: "server:x",
      clientEventId: "exposure-empty",
    });
    expect(applied).toBe(false);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'exposure-empty'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("N4 P2 fix (round 2): rejects an ACCEPT missing its required agentId", async () => {
    const taskId = "77777777-7777-7777-7777-777777777777";
    await seedTaskAndAgent(taskId, "88888888-8888-8888-8888-888888888888");

    const applied = await applyInteractionEventOutboxPayload(pool, {
      kind: "interaction_event",
      eventType: "ACCEPT",
      sessionId: serverSessionId(taskId),
      clientEventId: "accept-no-agent",
      taskId,
    });
    expect(applied).toBe(false);

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = 'accept-no-agent'`,
    );
    expect(rows).toHaveLength(0);
  });
});
