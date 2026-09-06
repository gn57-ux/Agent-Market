import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { Pool } from "pg";
import { applyInteractionEvent, isInteractionEventPayload } from "./interaction-events.js";

/**
 * Real-Postgres integration test for T-1901's real `apps/worker` business
 * handler (the fix for N4's own P1 finding: the handler previously only
 * logged a received payload, so ACCEPT/SUBMIT/APPROVE/RATE/REFUND/DISPUTE/
 * EXPOSURE events would reach `outbox_events`/the queue but never actually
 * become `interaction_events` rows in a live deployment).
 *
 * Skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1 against a
 * confirmed-safe TEST_DATABASE_URL — same convention as every
 * `*.integration.test.ts` suite in `apps/api`. Assumes migrations have
 * already been applied to that database (this package has no migration
 * runner of its own — `apps/api`'s `pnpm migrate` is the single owner of
 * schema application, matching this monorepo's established "one owner per
 * piece of design knowledge" convention).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "RUN_DB_INTEGRATION_TESTS=1 requires an explicit TEST_DATABASE_URL pointing at a " +
        "database you have confirmed is safe to write to and have data dropped from.",
    );
  }
  return url;
}

runIfOptedIn("apps/worker interaction-event handler (integration, T-1901)", () => {
  let pool: Pool;
  const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
  const taskId = "66666666-6666-6666-6666-666666666666";
  const agentId = "77777777-7777-7777-7777-777777777777";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
    await pool.query(
      `INSERT INTO tasks (id, requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, $2, 'writing', 'Test Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'OPEN', 'AUTOMATION')
       ON CONFLICT (id) DO NOTHING`,
      [taskId, REQUESTER_ADDRESS],
    );
    await pool.query(
      `INSERT INTO agents (id, owner_address, name, description, category, payout_address)
       VALUES ($1, $2, 'Test Agent', 'desc', 'writing', $2)
       ON CONFLICT (id) DO NOTHING`,
      [agentId, REQUESTER_ADDRESS],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM users WHERE address = $1`, [REQUESTER_ADDRESS]);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM interaction_events`);
  });

  it("isInteractionEventPayload accepts a real interaction-event-shaped payload and rejects an unrelated one", () => {
    expect(
      isInteractionEventPayload({
        kind: "interaction_event",
        eventType: "ACCEPT",
        sessionId: "server:x",
        clientEventId: "accept:x",
        taskId: "11111111-1111-1111-1111-111111111111",
        agentId: "22222222-2222-2222-2222-222222222222",
      }),
    ).toBe(true);
    expect(isInteractionEventPayload({ totallyUnrelated: true })).toBe(false);
    expect(isInteractionEventPayload(null)).toBe(false);
  });

  it("N4 P2 fix (round 2): rejects an ACCEPT missing its required agentId, even though the shape is otherwise valid", () => {
    expect(
      isInteractionEventPayload({
        kind: "interaction_event",
        eventType: "ACCEPT",
        sessionId: "server:x",
        clientEventId: "accept:x",
        taskId: "11111111-1111-1111-1111-111111111111",
      }),
    ).toBe(false);
  });

  it("N4 P2 fix (round 2): rejects a shape-valid but semantically-empty EXPOSURE (no taskId/agentId/runId)", () => {
    expect(
      isInteractionEventPayload({
        kind: "interaction_event",
        eventType: "EXPOSURE",
        sessionId: "server:x",
        clientEventId: "exposure:x",
      }),
    ).toBe(false);
  });

  it("applyInteractionEvent writes a real interaction_events row from a relayed outbox payload", async () => {
    const client = await pool.connect();
    try {
      await applyInteractionEvent(client, {
        kind: "interaction_event",
        eventType: "ACCEPT",
        sessionId: `server:${taskId}`,
        clientEventId: `accept:${taskId}`,
        taskId,
        agentId,
        actorAddress: "0xabc0000000000000000000000000000000000a",
      });
    } finally {
      client.release();
    }

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

  it("AC-1902: applying the same payload twice (simulated at-least-once redelivery) is a safe no-op", async () => {
    const payload = {
      kind: "interaction_event" as const,
      eventType: "SUBMIT",
      sessionId: `server:${taskId}`,
      clientEventId: `submit:${taskId}`,
      taskId,
      agentId,
    };

    const client = await pool.connect();
    try {
      await applyInteractionEvent(client, payload);
      await applyInteractionEvent(client, payload);
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT id FROM interaction_events WHERE client_event_id = $1`,
      [`submit:${taskId}`],
    );
    expect(rows).toHaveLength(1);
  });
});
