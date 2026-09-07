import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { createPostgresQueueAdapter, relayPendingMessages } from "@agent-market/queue";
import { runMigrations } from "../../db/migrate.js";
import { claimPendingOutboxEvents, writeOutboxEvent } from "./repository.js";

/**
 * T-1801's own real verification requirement (tasks.md): "一条 outbox 事件
 * 在两种适配器下均能被真实消费一次，行为一致（契约测试覆盖两个实现）" — the
 * Postgres half of that: a real `outbox_events` row, written the same way
 * T-1800's own atomicity proof writes one, genuinely relayed through a
 * real `pg-boss` queue and consumed exactly once by a real subscribed
 * worker, ending in the row being marked `SENT`. `packages/queue`'s own
 * `relay.test.ts` already proves `relayPendingMessages`'s dispatch logic
 * against fakes; this file is what proves the REAL wiring — this
 * project's own real `outbox_events` schema, this project's own real
 * `writeOutboxEvent`/`claimPendingOutboxEvents`, and a real `pg-boss`
 * instance — actually fit together, which a fakes-only test cannot show.
 * It also proves the N4 P1 fix (concurrent-relay double-publish) against
 * a REAL race on real `FOR UPDATE SKIP LOCKED` claim locks, not just the
 * fakes-based version already in `packages/queue/test/relay.test.ts`.
 *
 * The SQS half of this same AC is `packages/queue/test/sqs-adapter.contract.test.ts`
 * (logic-verified against the real AWS SDK's command classes, not a real
 * AWS account — see that file's own doc comment for why a genuine
 * end-to-end SQS run needs real credentials this environment doesn't
 * have).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

async function writeOutboxRow(pool: Pool, note: string): Promise<string> {
  const client = await pool.connect();
  try {
    return await writeOutboxEvent(client, {
      aggregateType: "test_aggregate",
      aggregateId: "00000000-0000-0000-0000-000000000001",
      eventType: "TEST_RELAYED_EVENT",
      payload: { note },
    });
  } finally {
    client.release();
  }
}

runIfOptedIn("outbox → queue relay, real pg-boss (integration, T-1801)", () => {
  let pool: Pool;
  let queue: ReturnType<typeof createPostgresQueueAdapter>;
  const queueName = "outbox-relay-test-queue";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    queue = createPostgresQueueAdapter(requireTestDatabaseUrl());
    await queue.createQueue(queueName);
  });

  afterAll(async () => {
    await queue?.stop();
    await pool.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM outbox_events");
  });

  it("AC-1801: an outbox row written now, relayed later, is delivered to a real consumer exactly once and marked SENT", async () => {
    const outboxId = await writeOutboxRow(pool, "relayed via real pg-boss");

    // Real "process restart" simulation: this relay call happens in a
    // completely separate step from the write above, exactly as it would
    // after a real crash-and-restart — nothing here depends on being in
    // the same transaction or even the same call stack as the write.
    const relayResult = await relayPendingMessages({
      source: { claimPending: (limit) => claimPendingOutboxEvents(pool, limit) },
      queue,
      queueName,
    });
    expect(relayResult.relayed).toBe(1);

    const { rows: sentRows } = await pool.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE id = $1`,
      [outboxId],
    );
    expect(sentRows[0]?.status).toBe("SENT");

    const consumed: unknown[] = [];
    let resolveConsumed: () => void;
    const consumedPromise = new Promise<void>((resolve) => {
      resolveConsumed = resolve;
    });
    await queue.subscribe(queueName, async (message) => {
      consumed.push(message.payload);
      resolveConsumed();
    });

    await Promise.race([
      consumedPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), 10_000)),
    ]);
    await queue.unsubscribe(queueName);

    // T-1802: the relay now publishes an envelope carrying the outbox
    // event's own stable id alongside its payload (see relay.ts's own
    // doc comment) — the business-level idempotency key AC-1802's
    // consumer needs, since queue-native message ids alone can't survive
    // a relay-crash-then-republish scenario.
    expect(consumed).toEqual([{ id: outboxId, payload: { note: "relayed via real pg-boss" } }]);

    // A second relay pass finds nothing new — the row is already SENT,
    // proving this isn't a re-deliverable-forever design.
    const secondRelay = await relayPendingMessages({
      source: { claimPending: (limit) => claimPendingOutboxEvents(pool, limit) },
      queue,
      queueName,
    });
    expect(secondRelay.relayed).toBe(0);
  }, 15_000);

  it("N4 P1 fix: two concurrent relay passes over the same pending rows never both publish the same row (real FOR UPDATE SKIP LOCKED race, not a fake)", async () => {
    const ids = await Promise.all([
      writeOutboxRow(pool, "race-1"),
      writeOutboxRow(pool, "race-2"),
      writeOutboxRow(pool, "race-3"),
    ]);

    // Two genuinely concurrent relay passes over the same 3 pending rows —
    // before the N4 fix, both would have read all 3 rows via a plain
    // SELECT and both would have published all 3, delivering each twice.
    const [first, second] = await Promise.all([
      relayPendingMessages({
        source: { claimPending: (limit) => claimPendingOutboxEvents(pool, limit) },
        queue,
        queueName,
        limit: 10,
      }),
      relayPendingMessages({
        source: { claimPending: (limit) => claimPendingOutboxEvents(pool, limit) },
        queue,
        queueName,
        limit: 10,
      }),
    ]);

    // Combined, the two concurrent passes relayed each of the 3 rows
    // EXACTLY once in total — never both passes claiming the same row.
    expect(first.relayed + second.relayed).toBe(3);

    const { rows: sentRows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM outbox_events WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(sentRows.every((row) => row.status === "SENT")).toBe(true);
    expect(sentRows).toHaveLength(3);
  }, 15_000);

  it("N4 P1 fix (round 2): a claim failure (BEGIN/SELECT throws) does not leak the checked-out connection", async () => {
    // A dedicated max:1 pool makes a leak observable: if
    // claimPendingOutboxEvents's error path forgot to release its
    // checked-out client, this pool's ONLY connection would stay held
    // forever, and the follow-up query below would hang waiting for a
    // connection that never comes back.
    const singleConnectionPool = new Pool({
      connectionString: requireTestDatabaseUrl(),
      max: 1,
    });
    try {
      // Force the claim's own SELECT to fail with a real error (not a
      // simulated one) by temporarily renaming the table out from under
      // it, using a SEPARATE pool so the rename itself doesn't consume
      // the single-connection pool's one slot.
      await pool.query(`ALTER TABLE outbox_events RENAME TO outbox_events_temp_renamed`);
      try {
        await expect(claimPendingOutboxEvents(singleConnectionPool, 10)).rejects.toThrow();
      } finally {
        await pool.query(`ALTER TABLE outbox_events_temp_renamed RENAME TO outbox_events`);
      }

      // If the failed claim's client had leaked, this would hang until
      // the test's own timeout rather than resolving.
      await expect(
        Promise.race([
          singleConnectionPool.query("SELECT 1"),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("pool connection appears leaked")), 5_000),
          ),
        ]),
      ).resolves.toBeDefined();
    } finally {
      await singleConnectionPool.end();
    }
  }, 15_000);
});
