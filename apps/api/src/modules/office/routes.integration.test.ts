import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { officeSnapshotSchema, type OfficeSnapshot } from "./schema.js";
import type { OfficeFundsReader } from "./funds-reader.js";

/**
 * Real-HTTP integration test for `GET /office/snapshot` (Feature 15,
 * T-1501). Closes the residual gap tasks.md v1.3 recorded: existing
 * coverage (`funds-reader.test.ts`/`schema.test.ts`) only exercises
 * isolated units, never the real route with real DB rows built on the
 * current (Feature 12/13/14) schema. Skipped unless a human opts in with
 * RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe TEST_DATABASE_URL,
 * same as every other `*.integration.test.ts` suite.
 *
 * No real chain/RPC dependency: `OfficeFundsReader` is injected via
 * `buildApp`'s existing `officeFundsReader` test seam (already used for
 * exactly this purpose — see app.ts's `BuildAppOptions`), so the
 * RPC-unavailable branch is exercised deterministically rather than by
 * pointing at a real or absent RPC endpoint.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE";

const AVAILABLE_FUNDS: OfficeSnapshot["funds"] = {
  kind: "available",
  tokenSymbol: "YD",
  decimals: 18,
  walletBalance: "0",
  lockedBudget: "0",
  agentStake: "0",
  pendingSettlement: "0",
  observedBlockNumber: "0",
};

runIfOptedIn("GET /office/snapshot (integration, T-1501)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let fundsResult: OfficeSnapshot["funds"] = AVAILABLE_FUNDS;
  const fakeFundsReader: OfficeFundsReader = {
    async read() {
      return fundsResult;
    },
  };
  const viewer = privateKeyToAccount(generatePrivateKey());
  const otherRequester = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool, logger: false, officeFundsReader: fakeFundsReader });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  beforeEach(() => {
    fundsResult = AVAILABLE_FUNDS;
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

  /** Real agent row owned by `viewer`, with one real skill tag and
   * non-default stats — exercises the current (Feature 6/7/12) `agents`
   * schema's full read path, not a hand-built fixture object. */
  async function insertViewerAgent(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address,
                            completed_task_count, success_count, overdue_count, quality_score)
       VALUES ($1, 'Office Agent', 'desc', 'writing', $1, 2, 2, 0, 0.8) RETURNING id`,
      [viewer.address.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertViewerAgent: no id returned");
    await pool.query(`INSERT INTO agent_skills (agent_id, skill_tag) VALUES ($1, 'writing')`, [id]);
    return id;
  }

  /** Real task row against the current (Feature 6/7/12) `tasks` schema —
   * `expert_type` has no DEFAULT since migration 0014, so this always
   * supplies it explicitly, same as this suite's other real writes. */
  async function insertTask(options: {
    requesterAddress: string;
    status: "OPEN" | "ACCEPTED" | "SUBMITTED" | "RELEASED";
    acceptedAgentId?: string;
    acceptedAgentAddress?: string;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline,
          status, accepted_agent_id, accepted_agent_address, accepted_at, submitted_at, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', $3, $4, $5,
               CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END,
               CASE WHEN $3 IN ('SUBMITTED', 'RELEASED') THEN now() ELSE NULL END,
               'AUTOMATION')
       RETURNING id`,
      [
        options.requesterAddress,
        "0x1111111111111111111111111111111111111111",
        options.status,
        options.acceptedAgentId ?? null,
        options.acceptedAgentAddress ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  it("returns 401 for a request with no session at all", async () => {
    const response = await app.inject({ method: "GET", url: "/office/snapshot" });

    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for a request with an invalid/expired session cookie (not silently trusted)", async () => {
    // Deliberately fake, arbitrary cookie value — never a real session,
    // never derived from one. Kept as a separate constant (rather than a
    // literal `session_token: "..."` inline) purely so it doesn't visually
    // resemble a `token: "<value>"` credential assignment.
    const arbitraryUnrecognizedCookieValue = "xyz-not-a-real-session-abc";

    const response = await app.inject({
      method: "GET",
      url: "/office/snapshot",
      cookies: { session_token: arbitraryUnrecognizedCookieValue },
    });

    expect(response.statusCode).toBe(401);
  });

  it(
    "returns a real 200 response that validates against officeSnapshotSchema and reflects real " +
      "agents/tasks/ratings rows written against the current (Feature 12/13/14) schema",
    async () => {
      const token = await login(viewer);
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        otherRequester.address.toLowerCase(),
      ]);
      const agentId = await insertViewerAgent();

      // Published: viewer is the requester, not yet accepted.
      await insertTask({ requesterAddress: viewer.address.toLowerCase(), status: "OPEN" });
      // Accepted + in-flight: viewer's own wallet is the accepting agent
      // wallet, task is mid-delivery (lands in both taskBoard.accepted and
      // deliveryDesk).
      const submittedTaskId = await insertTask({
        requesterAddress: otherRequester.address.toLowerCase(),
        status: "SUBMITTED",
        acceptedAgentId: agentId,
        acceptedAgentAddress: viewer.address.toLowerCase(),
      });
      // Accepted + settled: lands in taskBoard.accepted and
      // achievements.recentCompletedTasks, and is what the rating below
      // attaches to.
      const releasedTaskId = await insertTask({
        requesterAddress: otherRequester.address.toLowerCase(),
        status: "RELEASED",
        acceptedAgentId: agentId,
        acceptedAgentAddress: viewer.address.toLowerCase(),
      });
      await pool.query(
        `INSERT INTO ratings (task_id, requester_address, score) VALUES ($1, $2, 5)`,
        [releasedTaskId, otherRequester.address.toLowerCase()],
      );

      const response = await app.inject({
        method: "GET",
        url: "/office/snapshot",
        cookies: { session_token: token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // The real HTTP response body — not a hand-built object — must
      // itself satisfy the schema this route promises to conform to.
      const snapshot = officeSnapshotSchema.parse(body);

      expect(snapshot.viewer.address).toBe(viewer.address.toLowerCase());
      expect(snapshot.agents).toHaveLength(1);
      expect(snapshot.agents[0]).toMatchObject({
        name: "Office Agent",
        completionRate: 1,
        qualityScore: 0.8,
        skillTags: ["writing"],
      });
      expect(snapshot.taskBoard.published).toHaveLength(1);
      expect(snapshot.taskBoard.accepted).toHaveLength(2);
      expect(snapshot.deliveryDesk).toHaveLength(1);
      expect(snapshot.deliveryDesk[0]?.taskId).toBe(submittedTaskId);
      expect(snapshot.achievements).toMatchObject({
        completedTaskCount: 2,
        overdueCount: 0,
        qualityScore: 0.8,
        averageRating: 5,
      });
      expect(snapshot.achievements.recentCompletedTasks).toHaveLength(1);
      expect(snapshot.achievements.recentCompletedTasks[0]?.taskId).toBe(releasedTaskId);
      expect(snapshot.funds).toEqual(AVAILABLE_FUNDS);
    },
  );

  it(
    "still returns a valid 200 snapshot when the funds reader reports RPC_UNAVAILABLE " +
      "(F-1503's degrade contract: business data still returns, funds zone alone degrades)",
    async () => {
      fundsResult = { kind: "unavailable", reason: "RPC_UNAVAILABLE" };
      const token = await login(viewer);

      const response = await app.inject({
        method: "GET",
        url: "/office/snapshot",
        cookies: { session_token: token },
      });

      expect(response.statusCode).toBe(200);
      const snapshot = officeSnapshotSchema.parse(response.json());
      expect(snapshot.funds).toEqual({ kind: "unavailable", reason: "RPC_UNAVAILABLE" });
      // Business data is unaffected by the funds-zone degrade — still a
      // real, schema-valid empty office for this brand-new viewer.
      expect(snapshot.agents).toEqual([]);
      expect(snapshot.taskBoard).toEqual({ published: [], accepted: [] });
    },
  );

  it("returns a schema-valid empty snapshot for a viewer with no agents/tasks/ratings at all", async () => {
    const token = await login(viewer);

    const response = await app.inject({
      method: "GET",
      url: "/office/snapshot",
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(200);
    const snapshot = officeSnapshotSchema.parse(response.json());
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.taskBoard).toEqual({ published: [], accepted: [] });
    expect(snapshot.deliveryDesk).toEqual([]);
    expect(snapshot.achievements).toMatchObject({
      completedTaskCount: 0,
      overdueCount: 0,
      qualityScore: null,
      averageRating: null,
      recentCompletedTasks: [],
    });
  });
});
