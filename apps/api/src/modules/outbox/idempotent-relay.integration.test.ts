import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import {
  createPostgresIdempotencyLedger,
  createPostgresQueueAdapter,
  relayPendingMessages,
  withIdempotentConsumption,
} from "@agent-market/queue";
import type { EventEnvelope } from "@agent-market/queue";
import { runMigrations } from "../../db/migrate.js";
import { claimPendingOutboxEvents, writeOutboxEvent } from "./repository.js";

/**
 * AC-1802's real full-chain proof: not just the ledger in isolation
 * (`packages/queue/test/postgres-idempotency-ledger.integration.test.ts`)
 * but the actual production code path — a real outbox row, relayed
 * through a real `pg-boss` queue as the `{id, payload}` envelope T-1802
 * introduced, consumed by a real `withIdempotentConsumption`-wrapped
 * handler backed by a real Postgres ledger — with the event genuinely
 * published TWICE (simulating exactly the relay-crash-before-commit
 * scenario `relay.ts`'s own doc comment names as the reason a
 * business-level idempotency key is needed at all), proving the real
 * business effect only ever applies once.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("outbox → queue → idempotent consumer, full real chain (integration, T-1802)", () => {
  let pool: Pool;
  let queue: ReturnType<typeof createPostgresQueueAdapter>;
  const queueName = "idempotent-relay-test-queue";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS test_idempotent_effects (event_id UUID PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    queue = createPostgresQueueAdapter(requireTestDatabaseUrl());
    await queue.createQueue(queueName);
  });

  afterAll(async () => {
    await queue?.stop();
    await pool.query(`DROP TABLE IF EXISTS test_idempotent_effects`);
    await pool.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM outbox_events");
    await pool.query("DELETE FROM processed_events");
    await pool.query("DELETE FROM test_idempotent_effects");
  });

  it("AC-1802: the same outbox event, published to the queue twice (simulated relay-crash-then-republish), is consumed with the business effect applied exactly once", async () => {
    const writerClient = await pool.connect();
    let outboxId: string;
    try {
      outboxId = await writeOutboxEvent(writerClient, {
        aggregateType: "test_aggregate",
        aggregateId: "00000000-0000-0000-0000-000000000001",
        eventType: "TEST_IDEMPOTENT_EVENT",
        payload: { note: "should apply once" },
      });
    } finally {
      writerClient.release();
    }

    await relayPendingMessages({
      source: { claimPending: (limit) => claimPendingOutboxEvents(pool, limit) },
      queue,
      queueName,
    });

    // Simulate the exact scenario that makes a business-level idempotency
    // key necessary in the first place: the SAME outbox event published to
    // the queue a second time as a genuinely separate message (what a
    // relay crash between a successful publish and its own commit would
    // produce) — real `pg-boss`, two real `send()` calls, same envelope.
    const outboxRow = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [outboxId],
    );
    await queue.publish(queueName, { id: outboxId, payload: outboxRow.rows[0]?.payload });

    const ledger = createPostgresIdempotencyLedger(pool, "test-idempotent-consumer");
    const handlerCalls: unknown[] = [];
    const handler = withIdempotentConsumption(ledger, async (payload, tx) => {
      handlerCalls.push(payload);
      await tx.query(`INSERT INTO test_idempotent_effects (event_id) VALUES ($1)`, [outboxId]);
    });

    let deliveries = 0;
    let resolveBothDelivered: () => void;
    const bothDeliveredPromise = new Promise<void>((resolve) => {
      resolveBothDelivered = resolve;
    });
    await queue.subscribe<EventEnvelope<{ note: string }>>(queueName, async (message) => {
      await handler(message);
      deliveries += 1;
      if (deliveries === 2) resolveBothDelivered();
    });

    await Promise.race([
      bothDeliveredPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), 10_000)),
    ]);
    await queue.unsubscribe(queueName);

    // Both queue deliveries genuinely happened (2 real messages)...
    expect(deliveries).toBe(2);
    // ...but the real business effect (the wrapped handler's own write)
    // ran exactly once — this is AC-1802's own text ("最终业务状态与只消费
    // 一次时一致") made real.
    expect(handlerCalls).toEqual([{ note: "should apply once" }]);
    const { rows: effectRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM test_idempotent_effects WHERE event_id = $1`,
      [outboxId],
    );
    expect(effectRows[0]?.count).toBe("1");
  }, 15_000);
});
