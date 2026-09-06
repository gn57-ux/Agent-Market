import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";

/**
 * F-1605/F-1606 (Feature 16, T-1605, design.md 决策 3) — real end-to-end
 * coverage for AC-1605: `POST /agents/:agentId/submit-review`, `GET
 * /admin/agents/review-queue`, `POST /admin/agents/:agentId/{approve,
 * reject,suspend}`. Real HTTP (`app.inject`), real Postgres, real SIWE
 * signatures throughout.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn("Agent review lifecycle (integration, T-1605, AC-1605)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const admin = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agent_review_audit_logs, agents, sessions, auth_nonces, users, consumed_privy_tokens, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_review_audit_logs");
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM admin_role_audit_logs");
    await pool.query("DELETE FROM admin_roles");
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

  async function seedAdmin(): Promise<void> {
    const address = admin.address.toLowerCase();
    await pool.query(`INSERT INTO admin_roles (address, granted_by) VALUES ($1, $1)`, [address]);
  }

  async function createAgent(
    token: string,
    pricingType: "FREE" | "PER_TASK" | "SUBSCRIPTION" | "HOURLY",
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: {
        name: `Agent ${pricingType} ${Date.now()}`,
        description: "desc",
        category: "writing",
        skillTags: ["copywriting"],
        payoutAddress: owner.address,
        pricingType,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().agentId;
  }

  describe("GET /agents/:agentId visibility for a non-ACTIVE reviewStatus (Codex review, T-1605 round 1 P1)", () => {
    it("a stranger gets 404 for a PENDING_REVIEW Agent — indistinguishable from nonexistent", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(404);
    });

    it("an anonymous (no session) caller also gets 404 for a REJECTED Agent", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);
      await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/reject`,
        cookies: { session_token: adminToken },
        payload: { reason: "no" },
      });

      const response = await app.inject({ method: "GET", url: `/agents/${agentId}` });
      expect(response.statusCode).toBe(404);
    });

    it("the owner can always see their own Agent's detail regardless of reviewStatus", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");

      const response = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("PENDING_REVIEW");
    });

    it("an admin can always see any Agent's detail regardless of reviewStatus", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("PENDING_REVIEW");
    });

    it("an ACTIVE Agent's detail remains publicly visible to anyone, as before", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "FREE");

      const response = await app.inject({ method: "GET", url: `/agents/${agentId}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("ACTIVE");
    });
  });

  describe("POST /agents/:agentId/submit-review", () => {
    it("DRAFT → PENDING_REVIEW for the owner (no creation path currently produces DRAFT — set up directly, matching design.md's state machine contract for this endpoint)", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await pool.query(`UPDATE agents SET review_status = 'DRAFT' WHERE id = $1`, [agentId]);

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/submit-review`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("PENDING_REVIEW");

      const { rows } = await pool.query(
        `SELECT from_status, to_status, actor_address FROM agent_review_audit_logs WHERE agent_id = $1`,
        [agentId],
      );
      expect(rows).toEqual([
        {
          from_status: "DRAFT",
          to_status: "PENDING_REVIEW",
          actor_address: owner.address.toLowerCase(),
        },
      ]);
    });

    it("rejects with 409 when the Agent isn't in DRAFT (e.g. already PENDING_REVIEW from paid creation)", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/submit-review`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(409);
    });

    it("rejects a non-owner with 403", async () => {
      const ownerToken = await login(owner);
      const agentId = await createAgent(ownerToken, "PER_TASK");
      await pool.query(`UPDATE agents SET review_status = 'DRAFT' WHERE id = $1`, [agentId]);
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/submit-review`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(403);
    });

    it("returns 404 for a nonexistent Agent", async () => {
      const token = await login(owner);
      const response = await app.inject({
        method: "POST",
        url: `/agents/00000000-0000-0000-0000-000000000000/submit-review`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /admin/agents/review-queue", () => {
    it("lists only PENDING_REVIEW Agents, never FREE/ACTIVE ones", async () => {
      const token = await login(owner);
      const pendingId = await createAgent(token, "PER_TASK");
      await createAgent(token, "FREE");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "GET",
        url: "/admin/agents/review-queue",
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items.map((item: { agentId: string }) => item.agentId)).toEqual([pendingId]);
      expect(body.total).toBe(1);
    });

    it("rejects a non-admin session with 403", async () => {
      const token = await login(owner);
      const response = await app.inject({
        method: "GET",
        url: "/admin/agents/review-queue",
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("POST /admin/agents/:agentId/approve", () => {
    it("PENDING_REVIEW → ACTIVE, and the Agent becomes visible in the default (ACTIVE-only) market listing", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/approve`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("ACTIVE");

      const listResponse = await app.inject({ method: "GET", url: "/agents" });
      expect(listResponse.json().items.map((item: { agentId: string }) => item.agentId)).toContain(
        agentId,
      );
    });

    it("rejects with 409 when the Agent isn't PENDING_REVIEW", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "FREE");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/approve`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(409);
    });

    it("rejects a non-admin session with 403", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/approve`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("POST /admin/agents/:agentId/reject", () => {
    it("PENDING_REVIEW → REJECTED, records the reason in the audit log", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/reject`,
        cookies: { session_token: adminToken },
        payload: { reason: "描述不完整" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("REJECTED");

      const { rows } = await pool.query(
        `SELECT to_status, reason FROM agent_review_audit_logs WHERE agent_id = $1`,
        [agentId],
      );
      expect(rows).toEqual([{ to_status: "REJECTED", reason: "描述不完整" }]);
    });

    it("rejects with 400 when reason is missing or blank", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);

      const missing = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/reject`,
        cookies: { session_token: adminToken },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const blank = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/reject`,
        cookies: { session_token: adminToken },
        payload: { reason: "   " },
      });
      expect(blank.statusCode).toBe(400);
    });

    it("rejects with 409 when the Agent isn't PENDING_REVIEW", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "FREE");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/reject`,
        cookies: { session_token: adminToken },
        payload: { reason: "not applicable" },
      });
      expect(response.statusCode).toBe(409);
    });

    it(
      "two admins concurrently approving and rejecting the SAME PENDING_REVIEW Agent never both " +
        "succeed — setAgentReviewStatus's row lock (agents/repository.ts) serializes them, so " +
        "exactly one transition wins and the other sees a state that's already moved on",
      async () => {
        const token = await login(owner);
        const agentId = await createAgent(token, "PER_TASK");
        await seedAdmin();
        const adminToken = await login(admin);

        const [approveResponse, rejectResponse] = await Promise.all([
          app.inject({
            method: "POST",
            url: `/admin/agents/${agentId}/approve`,
            cookies: { session_token: adminToken },
          }),
          app.inject({
            method: "POST",
            url: `/admin/agents/${agentId}/reject`,
            cookies: { session_token: adminToken },
            payload: { reason: "concurrent reject" },
          }),
        ]);
        const statusCodes = [approveResponse.statusCode, rejectResponse.statusCode].sort();
        // One succeeds (200), the other loses the race and finds the Agent
        // no longer PENDING_REVIEW by the time its own lock is granted (409).
        expect(statusCodes).toEqual([200, 409]);

        const { rows } = await pool.query<{ review_status: string }>(
          `SELECT review_status FROM agents WHERE id = $1`,
          [agentId],
        );
        // Never left in some third/corrupted state — exactly one of the two
        // legal outcomes.
        expect(["ACTIVE", "REJECTED"]).toContain(rows[0]?.review_status);

        const { rows: auditRows } = await pool.query(
          `SELECT to_status FROM agent_review_audit_logs WHERE agent_id = $1`,
          [agentId],
        );
        // Exactly one audit row — the loser's transaction rolled back
        // entirely, including its own audit insert.
        expect(auditRows).toHaveLength(1);
      },
    );
  });

  describe("POST /admin/agents/:agentId/suspend", () => {
    it("ACTIVE → SUSPENDED with a required reason, and the Agent disappears from the default market listing", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "FREE");
      await seedAdmin();
      const adminToken = await login(admin);

      const beforeSuspend = await app.inject({ method: "GET", url: "/agents" });
      expect(beforeSuspend.json().items.map((item: { agentId: string }) => item.agentId)).toContain(
        agentId,
      );

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/suspend`,
        cookies: { session_token: adminToken },
        payload: { reason: "违反平台规则" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("SUSPENDED");

      const afterSuspend = await app.inject({ method: "GET", url: "/agents" });
      expect(
        afterSuspend.json().items.map((item: { agentId: string }) => item.agentId),
      ).not.toContain(agentId);

      // The owner can still see their own suspended Agent's full detail via
      // GET /agents/:agentId (their session cookie proves ownership) — only
      // excluded from the ACTIVE-only market listing, not made invisible to
      // its own owner.
      const ownerDetailResponse = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
      });
      expect(ownerDetailResponse.statusCode).toBe(200);
      expect(ownerDetailResponse.json().reviewStatus).toBe("SUSPENDED");

      // Codex review (T-1605 round 1 P1): an anonymous/non-owner viewer must
      // NOT be able to read a suspended Agent's detail just by knowing its
      // UUID — it must be indistinguishable from a nonexistent Agent.
      const anonymousDetailResponse = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
      });
      expect(anonymousDetailResponse.statusCode).toBe(404);
    });

    it("rejects with 409 when the Agent isn't ACTIVE (e.g. still PENDING_REVIEW)", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/suspend`,
        cookies: { session_token: adminToken },
        payload: { reason: "n/a" },
      });
      expect(response.statusCode).toBe(409);
    });

    it("rejects with 400 when reason is missing", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "FREE");
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/suspend`,
        cookies: { session_token: adminToken },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /agents/:agentId/appeal", () => {
    it("REJECTED → PENDING_REVIEW for the owner; the Agent reappears in the review queue, and the appeal is recorded in the audit log", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);
      await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/reject`,
        cookies: { session_token: adminToken },
        payload: { reason: "not ready" },
      });

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/appeal`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("PENDING_REVIEW");

      const queueResponse = await app.inject({
        method: "GET",
        url: "/admin/agents/review-queue",
        cookies: { session_token: adminToken },
      });
      expect(queueResponse.json().items.map((item: { agentId: string }) => item.agentId)).toContain(
        agentId,
      );

      const { rows } = await pool.query(
        `SELECT from_status, to_status FROM agent_review_audit_logs WHERE agent_id = $1 ORDER BY occurred_at`,
        [agentId],
      );
      expect(rows).toEqual([
        { from_status: "PENDING_REVIEW", to_status: "REJECTED" },
        { from_status: "REJECTED", to_status: "PENDING_REVIEW" },
      ]);
    });

    it("SUSPENDED → PENDING_REVIEW for the owner", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "FREE");
      await seedAdmin();
      const adminToken = await login(admin);
      await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/suspend`,
        cookies: { session_token: adminToken },
        payload: { reason: "violation" },
      });

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/appeal`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reviewStatus).toBe("PENDING_REVIEW");
    });

    it("rejects with 409 when the Agent is neither REJECTED nor SUSPENDED (e.g. still PENDING_REVIEW)", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/appeal`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(409);
    });

    it("rejects a non-owner with 403", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token, "PER_TASK");
      await seedAdmin();
      const adminToken = await login(admin);
      await app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/reject`,
        cookies: { session_token: adminToken },
        payload: { reason: "not ready" },
      });
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/appeal`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(403);
    });

    it("returns 404 for a nonexistent Agent", async () => {
      const token = await login(owner);
      const response = await app.inject({
        method: "POST",
        url: `/agents/00000000-0000-0000-0000-000000000000/appeal`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
