import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { buildSignInMessage } from "../auth/signInMessage.js";

/**
 * Real-HTTP integration test for T-1003's `POST /tasks/:taskId/ratings`
 * (F-1005). Skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1
 * against a confirmed-safe TEST_DATABASE_URL, same as every other
 * `*.integration.test.ts` suite.
 *
 * Covers AC-1004 (settled-only, once-per-task), AC-1008 (this route only
 * ever writes `agents.quality_score`, never
 * `completed_task_count`/`success_count`/`overdue_count`), and AC-1010's
 * back half (aggregation reads only real `ratings` rows and the resulting
 * `agents.quality_score` never regresses to a placeholder). The
 * concurrent-submission test proves the agent-row lock added in
 * `ratings/routes.ts` prevents a lost update when two different tasks for
 * the same Agent are rated at nearly the same time.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE";

runIfOptedIn("POST /tasks/:taskId/ratings (integration, T-1003)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const requester = privateKeyToAccount(generatePrivateKey());
  const otherRequester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());

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
    await pool.query("DELETE FROM ratings");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
  });

  async function login(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
    const nonceResponse = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address: account.address },
    });
    const { nonce, issuedAt, expiresAt } = nonceResponse.json();
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await account.signMessage({ message });
    const verifyResponse = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce },
    });
    const setCookie = verifyResponse.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = /session_token=([^;]+)/.exec(String(header));
    if (!match?.[1]) throw new Error("no session_token cookie in verify response");
    return match[1];
  }

  async function insertAgentRow(): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2), ($3) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      otherRequester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address,
                            completed_task_count, success_count, overdue_count)
       VALUES ($1, 'Agent', 'desc', 'writing', $1, 3, 2, 1) RETURNING id`,
      [agent.address.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgentRow: no id returned");
    return id;
  }

  async function insertTaskWithStatus(
    status: "SUBMITTED" | "RELEASED" | "REFUNDED",
    agentId: string,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline,
          status, accepted_agent_address, accepted_agent_id, accepted_at)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', $3, $4, $5, now())
       RETURNING id`,
      [
        requester.address.toLowerCase(),
        "0x1111111111111111111111111111111111111111",
        status,
        agent.address.toLowerCase(),
        agentId,
      ],
    );
    const taskId = rows[0]?.id;
    if (!taskId) throw new Error("insertTaskWithStatus: no id returned");
    return taskId;
  }

  async function agentStats(agentId: string): Promise<{
    completed: number;
    success: number;
    overdue: number;
    qualityScore: number | null;
  }> {
    const { rows } = await pool.query<{
      completed_task_count: number;
      success_count: number;
      overdue_count: number;
      quality_score: number | null;
    }>(
      `SELECT completed_task_count, success_count, overdue_count, quality_score
       FROM agents WHERE id = $1`,
      [agentId],
    );
    const row = rows[0];
    if (!row) throw new Error("agentStats: agent not found");
    return {
      completed: row.completed_task_count,
      success: row.success_count,
      overdue: row.overdue_count,
      qualityScore: row.quality_score,
    };
  }

  it("accepts a rating on a RELEASED task from the requester and normalizes quality_score, leaving settlement counters untouched (AC-1004, AC-1008)", async () => {
    const agentId = await insertAgentRow();
    const taskId = await insertTaskWithStatus("RELEASED", agentId);
    const token = await login(requester);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/ratings`,
      cookies: { session_token: token },
      payload: { score: 5 },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { ratingId: string };
    expect(body.ratingId).toBeTruthy();

    const stats = await agentStats(agentId);
    expect(stats.qualityScore).toBeCloseTo(1, 10); // score 5 -> (5-1)/4 = 1.0
    // AC-1008: this route must never touch the settlement counters.
    expect(stats).toMatchObject({ completed: 3, success: 2, overdue: 1 });
  });

  it("accepts a rating on a REFUNDED task too — settlement outcome does not gate rating eligibility", async () => {
    const agentId = await insertAgentRow();
    const taskId = await insertTaskWithStatus("REFUNDED", agentId);
    const token = await login(requester);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/ratings`,
      cookies: { session_token: token },
      payload: { score: 2 },
    });

    expect(response.statusCode).toBe(201);
  });

  it("rejects a rating on a task that is not yet settled (409)", async () => {
    const agentId = await insertAgentRow();
    const taskId = await insertTaskWithStatus("SUBMITTED", agentId);
    const token = await login(requester);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/ratings`,
      cookies: { session_token: token },
      payload: { score: 4 },
    });

    expect(response.statusCode).toBe(409);
  });

  it("rejects a rating from a non-requester (403)", async () => {
    const agentId = await insertAgentRow();
    const taskId = await insertTaskWithStatus("RELEASED", agentId);
    const token = await login(otherRequester);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/ratings`,
      cookies: { session_token: token },
      payload: { score: 4 },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a second rating submission for the same task (409), and does not re-aggregate", async () => {
    const agentId = await insertAgentRow();
    const taskId = await insertTaskWithStatus("RELEASED", agentId);
    const token = await login(requester);

    const first = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/ratings`,
      cookies: { session_token: token },
      payload: { score: 5 },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/ratings`,
      cookies: { session_token: token },
      payload: { score: 1 },
    });
    expect(second.statusCode).toBe(409);

    const stats = await agentStats(agentId);
    expect(stats.qualityScore).toBeCloseTo(1, 10); // still just the first score
  });

  it("aggregates real scores across multiple settled tasks for the same Agent (AC-1010)", async () => {
    const agentId = await insertAgentRow();
    const taskA = await insertTaskWithStatus("RELEASED", agentId);
    const taskB = await insertTaskWithStatus("RELEASED", agentId);
    const token = await login(requester);

    await app.inject({
      method: "POST",
      url: `/tasks/${taskA}/ratings`,
      cookies: { session_token: token },
      payload: { score: 5 },
    });
    await app.inject({
      method: "POST",
      url: `/tasks/${taskB}/ratings`,
      cookies: { session_token: token },
      payload: { score: 3 },
    });

    const stats = await agentStats(agentId);
    // mean(5,3) = 4, normalized = (4-1)/4 = 0.75
    expect(stats.qualityScore).toBeCloseTo(0.75, 10);
  });

  it("does not lose an update when two different tasks for the same Agent are rated concurrently", async () => {
    const agentId = await insertAgentRow();
    const taskA = await insertTaskWithStatus("RELEASED", agentId);
    const taskB = await insertTaskWithStatus("RELEASED", agentId);
    const token = await login(requester);

    const [responseA, responseB] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/tasks/${taskA}/ratings`,
        cookies: { session_token: token },
        payload: { score: 5 },
      }),
      app.inject({
        method: "POST",
        url: `/tasks/${taskB}/ratings`,
        cookies: { session_token: token },
        payload: { score: 1 },
      }),
    ]);
    expect(responseA.statusCode).toBe(201);
    expect(responseB.statusCode).toBe(201);

    const { rows } = await pool.query(`SELECT score FROM ratings WHERE task_id IN ($1, $2)`, [
      taskA,
      taskB,
    ]);
    expect(rows).toHaveLength(2);

    const stats = await agentStats(agentId);
    // mean(5,1) = 3, normalized = (3-1)/4 = 0.5 — the ONLY value consistent
    // with both ratings being counted; a lost update would leave whichever
    // transaction committed last as if it were the only rating (0.0 or 1.0).
    expect(stats.qualityScore).toBeCloseTo(0.5, 10);
  });

  // T-1006: GET /tasks/:taskId/ratings — RatingSection's own read.
  it("GET returns 404 for a settled task that has no rating yet", async () => {
    const agentId = await insertAgentRow();
    const taskId = await insertTaskWithStatus("RELEASED", agentId);

    const response = await app.inject({ method: "GET", url: `/tasks/${taskId}/ratings` });

    expect(response.statusCode).toBe(404);
  });

  it("GET returns the rating once one has been submitted, without requiring a session (public read)", async () => {
    const agentId = await insertAgentRow();
    const taskId = await insertTaskWithStatus("RELEASED", agentId);
    const token = await login(requester);
    const postResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/ratings`,
      cookies: { session_token: token },
      payload: { score: 4 },
    });
    expect(postResponse.statusCode).toBe(201);
    const { ratingId } = postResponse.json() as { ratingId: string };

    // No session cookie — proves this is a public read.
    const getResponse = await app.inject({ method: "GET", url: `/tasks/${taskId}/ratings` });

    expect(getResponse.statusCode).toBe(200);
    const body = getResponse.json() as { ratingId: string; score: number; createdAt: string };
    expect(body).toMatchObject({ ratingId, score: 4 });
    expect(typeof body.createdAt).toBe("string");
  });

  it("GET returns 404 for a nonexistent task", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/tasks/00000000-0000-4000-8000-000000000000/ratings`,
    });

    expect(response.statusCode).toBe(404);
  });
});
