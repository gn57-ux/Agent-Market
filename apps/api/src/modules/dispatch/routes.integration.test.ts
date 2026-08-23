import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";

// Mocked BEFORE importing app.ts/routes.ts (vi.mock calls are hoisted to
// the top of the file by Vitest) — this suite proves the route's
// orchestration (ownership check, candidate assembly, persistence) end to
// end against a real database, WITHOUT starting a real Go dispatch service
// (T-705 capsule: "不需要真的启动 Go 服务 — 单测/集成测试用一个假的 Go 响应"). The
// real `DispatchServiceUnavailableError` class is preserved via
// importOriginal so routes.ts's `instanceof` check still works against
// whatever this mock throws.
const callMatchMock = vi.fn();
vi.mock("./dispatch.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dispatch.client.js")>();
  return {
    ...actual,
    callMatch: (...args: Parameters<typeof actual.callMatch>) => callMatchMock(...args),
  };
});

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-705's end-to-end verification of
// POST /tasks/:taskId/match.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS recommendation_candidates, recommendation_runs, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, " +
  "sessions, auth_nonces, users, schema_migrations CASCADE";

const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn("POST /tasks/:taskId/match (integration, T-705)", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const requester = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    callMatchMock.mockReset();
    await pool.query("DELETE FROM recommendation_candidates");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agent_skills");
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

  async function insertOpenTask(requesterAddress: string): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requesterAddress,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN')
       RETURNING id`,
      [requesterAddress, TOKEN_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertOpenTask: no id returned");
    return id;
  }

  async function insertActiveAgent(): Promise<string> {
    const ownerAddress = "0x9983fefc63f0cd0e873a0000c6d07ef7b77e90d8";
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      ownerAddress,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [ownerAddress],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertActiveAgent: no id returned");
    return id;
  }

  it("401s an unauthenticated request", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const response = await app.inject({ method: "POST", url: `/tasks/${taskId}/match` });
    expect(response.statusCode).toBe(401);
    expect(callMatchMock).not.toHaveBeenCalled();
  });

  it("404s a nonexistent task", async () => {
    const token = await login(requester);
    const response = await app.inject({
      method: "POST",
      url: `/tasks/00000000-0000-0000-0000-000000000000/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s (not 403) when the caller isn't the task's requester", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const token = await login(stranger);
    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(404);
    expect(callMatchMock).not.toHaveBeenCalled();
  });

  it("assembles candidates, calls the dispatch service, persists the run + candidates, and returns the fixed response shape", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配", "评分最高"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ taskId, algorithmVersion: "v0.1", recommendationCount: 1 });

    expect(callMatchMock).toHaveBeenCalledTimes(1);
    const [sentRequest] = callMatchMock.mock.calls[0] as [{ candidates: unknown[] }];
    expect(sentRequest.candidates).toHaveLength(1);

    const { rows: runRows } = await pool.query<{ candidate_count: number; task_id: string }>(
      `SELECT candidate_count, task_id FROM recommendation_runs WHERE task_id = $1`,
      [taskId],
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.candidate_count).toBe(1);

    const { rows: candidateRows } = await pool.query<{ agent_id: string; rank: number }>(
      `SELECT agent_id, rank FROM recommendation_candidates rc
       JOIN recommendation_runs rr ON rr.id = rc.run_id
       WHERE rr.task_id = $1`,
      [taskId],
    );
    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]?.agent_id).toBe(agentId);
    expect(candidateRows[0]?.rank).toBe(1);
  });

  it("returns 502 when the dispatch service is unavailable, without persisting a run", async () => {
    const { DispatchServiceUnavailableError } = await import("./dispatch.client.js");
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const token = await login(requester);

    callMatchMock.mockRejectedValue(new DispatchServiceUnavailableError("boom"));

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  // Regression for Codex round 2 P2: a schema-valid response that isn't
  // actually FOR this task/algorithmVersion, or that recommends an agentId
  // never among this run's candidates, must be rejected rather than
  // persisted — a database FK alone can't catch this (the agentId being a
  // real agent somewhere doesn't mean it was a candidate for THIS run).
  it("returns 502 and persists nothing when the response's taskId doesn't match the request", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const otherTaskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId: otherTaskId, // wrong task
      algorithmVersion: "v0.1",
      recommendations: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("returns 502 and persists nothing when a recommendation names an agent that wasn't a candidate for this run", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    // A real agent that exists in the database but was never fetched as a
    // candidate for THIS run (no agent was inserted before this call, so
    // assembleCandidateSnapshots sees zero candidates) — the response
    // claims a recommendation for it anyway.
    const foreignAgentId = "00000000-0000-0000-0000-000000000000";
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId: foreignAgentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  // Regression for Codex round 1 P2: a schema-valid response can still
  // repeat the same agentId or rank across slots, which would let one agent
  // be issued more than one acceptance permit for the same task — must be
  // rejected before persistence, not just checked against candidate
  // membership.
  it("returns 502 and persists nothing when the response repeats the same agentId across recommendations", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        { agentId, rank: 2, slotType: "EXPLORATION", score: 0.5, reasons: ["y"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("returns 502 and persists nothing when the response repeats the same rank across recommendations", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const firstAgentId = await insertActiveAgent();
    const secondAgentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId: firstAgentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        { agentId: secondAgentId, rank: 1, slotType: "EXPLORATION", score: 0.5, reasons: ["y"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });
});

// T-706: GET /tasks/:taskId/recommendations and
// POST /tasks/:taskId/acceptance-permits — a separate top-level describe
// (its own pool/app/env setup) rather than folding into the T-705 suite
// above: these two routes never call the Go dispatch service (no
// `callMatchMock` involved), and acceptance-permits needs
// ACCEPTANCE_PERMIT_SIGNER_KEY/CHAIN_ID/TASK_ESCROW_ADDRESS env vars the
// T-705 suite has no reason to set.
runIfOptedIn(
  "GET /tasks/:taskId/recommendations, POST /tasks/:taskId/acceptance-permits (integration, T-706)",
  () => {
    let pool: Pool;
    let app: Awaited<ReturnType<typeof buildApp>>;
    const requester = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const signerPrivateKey = generatePrivateKey();
    const signerAccount = privateKeyToAccount(signerPrivateKey);
    const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";

    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = [
      "ACCEPTANCE_PERMIT_SIGNER_KEY",
      "CHAIN_ID",
      "TASK_ESCROW_ADDRESS",
      "YD_TOKEN_ADDRESS",
      "YD_FAUCET_ADDRESS",
    ];

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });

      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
      }
      process.env.ACCEPTANCE_PERMIT_SIGNER_KEY = signerPrivateKey;
      process.env.CHAIN_ID = "31337";
      process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
      process.env.YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      process.env.YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    afterEach(async () => {
      await pool.query("DELETE FROM recommendation_candidates");
      await pool.query("DELETE FROM recommendation_runs");
      await pool.query("DELETE FROM tasks");
      await pool.query("DELETE FROM agent_skills");
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

    async function insertOpenTask(requesterAddress: string): Promise<string> {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        requesterAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks
           (requester_address, category, title, description, budget, token, delivery_deadline, status)
         VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN')
         RETURNING id`,
        [requesterAddress, TOKEN_ADDRESS],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertOpenTask: no id returned");
      return id;
    }

    async function insertActiveAgent(ownerAddress: string): Promise<string> {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        ownerAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
        [ownerAddress],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertActiveAgent: no id returned");
      return id;
    }

    /** Bypasses insertRecommendationRun/POST /match entirely (no Go service
     * involved in this suite) — direct SQL insert of exactly the run +
     * candidate rows GET /recommendations and POST /acceptance-permits both
     * read back via getLatestRecommendationCandidates. */
    async function insertRecommendationRunDirect(
      taskId: string,
      candidates: Array<{
        agentId: string;
        rank: number;
        slotType: string;
        score: number;
        reasons: string[];
      }>,
      requestedAt?: Date,
    ): Promise<void> {
      const { rows } = await pool.query<{ id: string }>(
        requestedAt
          ? `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, requested_at)
             VALUES ($1, 'v0.1', $2, $3) RETURNING id`
          : `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count)
             VALUES ($1, 'v0.1', $2) RETURNING id`,
        requestedAt ? [taskId, candidates.length, requestedAt] : [taskId, candidates.length],
      );
      const runId = rows[0]?.id;
      if (!runId) throw new Error("insertRecommendationRunDirect: no id returned");
      for (const candidate of candidates) {
        await pool.query(
          `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            runId,
            candidate.agentId,
            candidate.rank,
            candidate.slotType,
            candidate.score,
            JSON.stringify(candidate.reasons),
          ],
        );
      }
    }

    describe("GET /tasks/:taskId/recommendations", () => {
      it("404s a nonexistent task", async () => {
        const response = await app.inject({
          method: "GET",
          url: `/tasks/00000000-0000-0000-0000-000000000000/recommendations`,
        });
        expect(response.statusCode).toBe(404);
      });

      it("returns an empty array (200, not 404) when no run exists yet", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ recommendations: [] });
      });

      it("is public — no session cookie required", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentId = await insertActiveAgent("0x1183fefc63f0cd0e873a0000c6d07ef7b77e90e1");
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配"] },
        ]);

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          recommendations: [
            { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配"] },
          ],
        });
      });

      it("returns candidates ordered by rank ascending, from only the latest run", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentA = await insertActiveAgent("0x2283fefc63f0cd0e873a0000c6d07ef7b77e90e2");
        const agentB = await insertActiveAgent("0x3383fefc63f0cd0e873a0000c6d07ef7b77e90e3");
        const agentC = await insertActiveAgent("0x4483fefc63f0cd0e873a0000c6d07ef7b77e90e4");

        // Older run — must NOT appear in the response.
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.5, reasons: ["旧一轮"] },
        ]);
        // Latest run, inserted with ranks out of order to prove the ORDER BY.
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.6, reasons: ["探索位"] },
          { agentId: agentC, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["最新一轮"] },
        ]);

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          recommendations: Array<{ agentId: string; rank: number }>;
        };
        expect(body.recommendations.map((r) => r.agentId)).toEqual([agentC, agentB]);
        expect(body.recommendations.map((r) => r.rank)).toEqual([1, 2]);
      });

      // Regression for Codex round 1 P2: `requested_at` (TIMESTAMPTZ) is not
      // a uniqueness guarantee — two runs landing at the identical instant
      // must still resolve to a single deterministic "latest" via
      // `sequence_no`, not whichever row Postgres happens to return first.
      it("resolves ties deterministically via sequence_no when two runs share the same requested_at", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentOlder = await insertActiveAgent("0x7783fefc63f0cd0e873a0000c6d07ef7b77e90e7");
        const agentNewer = await insertActiveAgent("0x8883fefc63f0cd0e873a0000c6d07ef7b77e90e8");
        const tiedTimestamp = new Date("2026-01-01T00:00:00Z");

        await insertRecommendationRunDirect(
          taskId,
          [
            {
              agentId: agentOlder,
              rank: 1,
              slotType: "TOP_SCORE",
              score: 0.5,
              reasons: ["先插入"],
            },
          ],
          tiedTimestamp,
        );
        await insertRecommendationRunDirect(
          taskId,
          [
            {
              agentId: agentNewer,
              rank: 1,
              slotType: "TOP_SCORE",
              score: 0.9,
              reasons: ["后插入"],
            },
          ],
          tiedTimestamp,
        );

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { recommendations: Array<{ agentId: string }> };
        // sequence_no is a BIGSERIAL, so the run inserted second (higher
        // sequence_no) is unambiguously "latest" despite the identical
        // requested_at.
        expect(body.recommendations.map((r) => r.agentId)).toEqual([agentNewer]);
      });
    });

    describe("POST /tasks/:taskId/acceptance-permits", () => {
      it("401s an unauthenticated request", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
        });
        expect(response.statusCode).toBe(401);
      });

      it("404s (not 403) when the caller isn't the task's requester", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const token = await login(stranger);
        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });
        expect(response.statusCode).toBe(404);
      });

      it("400s when no recommendation run exists yet", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const token = await login(requester);
        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });
        expect(response.statusCode).toBe(400);
      });

      it("issues one permit per candidate from the latest run, each matching the candidate's owner_address and the task's derived bytes32 id", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const ownerA = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90e5";
        const ownerB = "0x6683fefc63f0cd0e873a0000c6d07ef7b77e90e6";
        const agentA = await insertActiveAgent(ownerA);
        const agentB = await insertActiveAgent(ownerB);
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.6, reasons: ["y"] },
        ]);
        const token = await login(requester);

        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          permits: Array<{
            agentId: string;
            taskId: string;
            agentWalletAddress: string;
            nonce: string;
            expiry: number;
            chainId: number;
            verifyingContract: string;
            signature: string;
          }>;
        };
        expect(body.permits).toHaveLength(2);

        const { deriveOnChainTaskId } = await import("../tasks/onchain-task-id.js");
        const expectedTaskIdOnChain = deriveOnChainTaskId(taskId);

        const byAgent = new Map(body.permits.map((p) => [p.agentId, p]));
        expect(byAgent.get(agentA)?.agentWalletAddress.toLowerCase()).toBe(ownerA);
        expect(byAgent.get(agentB)?.agentWalletAddress.toLowerCase()).toBe(ownerB);

        for (const permit of body.permits) {
          expect(permit.taskId).toBe(taskId);
          expect(permit.chainId).toBe(31337);
          expect(permit.verifyingContract.toLowerCase()).toBe(TASK_ESCROW_ADDRESS.toLowerCase());
          expect(permit.signature).toMatch(/^0x[0-9a-fA-F]+$/);
          expect(typeof permit.nonce).toBe("string");
          expect(BigInt(permit.nonce)).toBeGreaterThan(0n);
        }

        // Every permit's signature verifies back to the configured
        // ACCEPTANCE_PERMIT_SIGNER_KEY's address — proves the route wired
        // permit.service.ts's actual signature into the response, not a
        // placeholder.
        const { verifyTypedData } = await import("viem");
        const { ACCEPTANCE_PERMIT_TYPES } = await import("./permit.service.js");
        for (const permit of body.permits) {
          const valid = await verifyTypedData({
            address: signerAccount.address,
            domain: {
              name: "AgentMarketTaskEscrow",
              version: "1",
              chainId: permit.chainId,
              verifyingContract: permit.verifyingContract as `0x${string}`,
            },
            types: ACCEPTANCE_PERMIT_TYPES,
            primaryType: "AcceptancePermit",
            message: {
              taskId: expectedTaskIdOnChain,
              agent: permit.agentWalletAddress as `0x${string}`,
              nonce: BigInt(permit.nonce),
              expiry: BigInt(permit.expiry),
              chainId: BigInt(permit.chainId),
              verifyingContract: permit.verifyingContract as `0x${string}`,
            },
            signature: permit.signature as `0x${string}`,
          });
          expect(valid).toBe(true);
        }
      });
    });
  },
);
