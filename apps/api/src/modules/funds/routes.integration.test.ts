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
 * F-1608 (Feature 16, T-1608, design.md 决策 4) — real end-to-end coverage
 * for AC-1607's three read-only funds views. Real HTTP (`app.inject`),
 * real Postgres, real SIWE signatures. Tasks are inserted directly via SQL
 * at their target status (matching dispatch/repository.integration.test.ts's
 * own established convention for this kind of aggregation test) rather than
 * driven through the full on-chain funding/acceptance/settlement flow,
 * which is unrelated to what this Task's own logic (pure SQL aggregation)
 * needs to prove.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn("Funds views (integration, T-1608, AC-1607)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agentOwner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const admin = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM chain_events");
    await pool.query("DELETE FROM tasks");
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

  async function ensureUser(address: string): Promise<void> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      address.toLowerCase(),
    ]);
  }

  async function insertAgent(ownerAddress: string): Promise<string> {
    await ensureUser(ownerAddress);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address, pricing_type, review_status)
       VALUES ($1, 'Agent', 'desc', 'writing', $1, 'FREE', 'ACTIVE')
       RETURNING id`,
      [ownerAddress.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertTask(overrides: {
    requesterAddress: string;
    budget: string;
    status: string;
    acceptedAgentId?: string;
  }): Promise<string> {
    await ensureUser(overrides.requesterAddress);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', $2, $3, '2030-01-01T00:00:00Z', $4, $5, 'AUTOMATION')
       RETURNING id`,
      [
        overrides.requesterAddress.toLowerCase(),
        overrides.budget,
        TOKEN_ADDRESS,
        overrides.status,
        overrides.acceptedAgentId ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  async function insertTaskAcceptedEvent(taskId: string, stake: string): Promise<void> {
    await pool.query(
      `INSERT INTO chain_events (chain_id, block_hash, transaction_hash, log_index, event_name, task_id, payload)
       VALUES (1, $1, $2, 0, 'TaskAccepted', $3, $4)`,
      [
        `0x${taskId.replace(/-/g, "").padEnd(64, "0")}`,
        `0x${taskId.replace(/-/g, "").padStart(64, "1")}`,
        taskId,
        JSON.stringify({ stake }),
      ],
    );
  }

  describe("GET /funds/requester/:address", () => {
    it("aggregates locked (OPEN/ACCEPTED/SUBMITTED/DISPUTED), settled (RELEASED/REFUNDED), pendingSettlement (DISPUTED) correctly, and never counts another requester's tasks", async () => {
      await insertTask({ requesterAddress: requester.address, budget: "100", status: "OPEN" });
      await insertTask({ requesterAddress: requester.address, budget: "200", status: "ACCEPTED" });
      await insertTask({
        requesterAddress: requester.address,
        budget: "300",
        status: "SUBMITTED",
      });
      await insertTask({ requesterAddress: requester.address, budget: "400", status: "DISPUTED" });
      await insertTask({ requesterAddress: requester.address, budget: "500", status: "RELEASED" });
      await insertTask({ requesterAddress: requester.address, budget: "600", status: "REFUNDED" });
      // Codex review (T-1608 round 1 P1): CANCELLED tasks DID have real
      // money move — contracts/src/TaskEscrow.sol::cancelTask refunds 100%
      // of budget back to the requester, only callable from OPEN. Counted
      // as settled, same as REFUNDED, never as locked.
      await insertTask({ requesterAddress: requester.address, budget: "700", status: "CANCELLED" });
      // Never-funded statuses must not contribute to any total.
      await insertTask({ requesterAddress: requester.address, budget: "999", status: "DRAFT" });
      await insertTask({
        requesterAddress: requester.address,
        budget: "999",
        status: "AWAITING_FUNDING",
      });
      // A different requester's task must never leak into this summary.
      await insertTask({ requesterAddress: stranger.address, budget: "999", status: "OPEN" });

      const token = await login(requester);
      const response = await app.inject({
        method: "GET",
        url: `/funds/requester/${requester.address}`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        locked: "1000",
        settled: "1800", // 500 + 600 + 700
        pendingSettlement: "400",
      });
    });

    it("returns all zeros for an address with no tasks at all (not a 404)", async () => {
      const token = await login(requester);
      const response = await app.inject({
        method: "GET",
        url: `/funds/requester/${requester.address}`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ locked: "0", settled: "0", pendingSettlement: "0" });
    });

    it("an admin can view any requester's funds view", async () => {
      await insertTask({ requesterAddress: requester.address, budget: "100", status: "OPEN" });
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "GET",
        url: `/funds/requester/${requester.address}`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().locked).toBe("100");
    });

    it("a stranger (not self, not admin) is rejected with 403", async () => {
      const strangerToken = await login(stranger);
      const response = await app.inject({
        method: "GET",
        url: `/funds/requester/${requester.address}`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(403);
    });

    it("no session is rejected with 401", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/funds/requester/${requester.address}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a malformed address with 400", async () => {
      const token = await login(requester);
      const response = await app.inject({
        method: "GET",
        url: `/funds/requester/not-an-address`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /funds/agent/:agentId", () => {
    it("aggregates stake (only for ACCEPTED/SUBMITTED/DISPUTED tasks), earnedIncome (RELEASED), pendingSettlement (DISPUTED)", async () => {
      const agentId = await insertAgent(agentOwner.address);

      const acceptedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "200",
        status: "ACCEPTED",
        acceptedAgentId: agentId,
      });
      await insertTaskAcceptedEvent(acceptedTask, "10");

      const submittedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "300",
        status: "SUBMITTED",
        acceptedAgentId: agentId,
      });
      await insertTaskAcceptedEvent(submittedTask, "20");

      const disputedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "400",
        status: "DISPUTED",
        acceptedAgentId: agentId,
      });
      await insertTaskAcceptedEvent(disputedTask, "30");

      const releasedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "500",
        status: "RELEASED",
        acceptedAgentId: agentId,
      });
      // The contract has already resolved this stake — its TaskAccepted
      // event still exists historically, but must NOT be counted as
      // currently staked once the task is terminal.
      await insertTaskAcceptedEvent(releasedTask, "40");

      const refundedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "600",
        status: "REFUNDED",
        acceptedAgentId: agentId,
      });
      await insertTaskAcceptedEvent(refundedTask, "50");

      const token = await login(agentOwner);
      const response = await app.inject({
        method: "GET",
        url: `/funds/agent/${agentId}`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        stake: "60", // 10 + 20 + 30 — RELEASED/REFUNDED excluded
        earnedIncome: "500",
        pendingSettlement: "400",
      });
    });

    it("returns all zeros for an Agent that has never accepted a task", async () => {
      const agentId = await insertAgent(agentOwner.address);
      const token = await login(agentOwner);
      const response = await app.inject({
        method: "GET",
        url: `/funds/agent/${agentId}`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        stake: "0",
        earnedIncome: "0",
        pendingSettlement: "0",
      });
    });

    it("an admin can view any Agent's funds view", async () => {
      const agentId = await insertAgent(agentOwner.address);
      await seedAdmin();
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "GET",
        url: `/funds/agent/${agentId}`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);
    });

    it("a stranger (not the Agent's owner, not admin) is rejected with 403", async () => {
      const agentId = await insertAgent(agentOwner.address);
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "GET",
        url: `/funds/agent/${agentId}`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(403);
    });

    it("returns 404 for a nonexistent Agent", async () => {
      const token = await login(agentOwner);
      const response = await app.inject({
        method: "GET",
        url: `/funds/agent/00000000-0000-0000-0000-000000000000`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(404);
    });

    it("no session is rejected with 401", async () => {
      const agentId = await insertAgent(agentOwner.address);
      const response = await app.inject({ method: "GET", url: `/funds/agent/${agentId}` });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /funds/platform", () => {
    it("aggregates totalEscrowed (every ever-funded status), totalReleased, totalRefunded, activeLocked correctly", async () => {
      await insertTask({ requesterAddress: requester.address, budget: "100", status: "OPEN" });
      const acceptedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "200",
        status: "ACCEPTED",
      });
      await insertTaskAcceptedEvent(acceptedTask, "6");
      const submittedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "300",
        status: "SUBMITTED",
      });
      await insertTaskAcceptedEvent(submittedTask, "12");
      const disputedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "400",
        status: "DISPUTED",
      });
      await insertTaskAcceptedEvent(disputedTask, "18");
      const releasedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "500",
        status: "RELEASED",
      });
      // Codex review (T-1608 round 2 P2): TaskEscrow.acceptTask locks an
      // EXTRA stake into escrow on top of budget — this must count toward
      // totalEscrowed (money that DID enter the contract) but not toward
      // totalReleased (the stake return isn't the Agent's earned payment).
      await insertTaskAcceptedEvent(releasedTask, "24");
      const refundedTask = await insertTask({
        requesterAddress: requester.address,
        budget: "600",
        status: "REFUNDED",
      });
      // REFUNDED only reachable via a prior DISPUTED (which requires prior
      // ACCEPTED) — its stake still counts toward totalEscrowed's
      // unconditional historical sum, but not toward activeLocked (no
      // longer sitting in escrow) or totalRefunded (not the requester's
      // money).
      await insertTaskAcceptedEvent(refundedTask, "30");
      // Codex review (T-1608 round 1 P1): a real refund event, must be
      // counted in both totalEscrowed (it WAS funded) and totalRefunded
      // (contracts/src/TaskEscrow.sol::cancelTask returns 100% of budget).
      // CANCELLED is only reachable from OPEN (never accepted), so it has
      // no TaskAccepted event / no stake to add anywhere.
      await insertTask({ requesterAddress: requester.address, budget: "700", status: "CANCELLED" });
      await insertTask({ requesterAddress: requester.address, budget: "999", status: "DRAFT" });
      await insertTask({
        requesterAddress: requester.address,
        budget: "999",
        status: "AWAITING_FUNDING",
      });

      await seedAdmin();
      const adminToken = await login(admin);
      const response = await app.inject({
        method: "GET",
        url: "/funds/platform",
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalEscrowed: "2890", // (100+200+300+400+500+600+700) + (6+12+18+24+30)
        totalReleased: "500", // budget only, stake return isn't "released" income
        totalRefunded: "1300", // 600 + 700, budget only
        activeLocked: "1036", // (100+200+300+400) + (6+12+18) — RELEASED/REFUNDED stake excluded
      });
    });

    it("a non-admin session is rejected with 403", async () => {
      const token = await login(requester);
      const response = await app.inject({
        method: "GET",
        url: "/funds/platform",
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(403);
    });

    it("no session is rejected with 401", async () => {
      const response = await app.inject({ method: "GET", url: "/funds/platform" });
      expect(response.statusCode).toBe(401);
    });
  });
});
