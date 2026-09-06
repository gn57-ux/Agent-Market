import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import {
  getCandidateInvitationsForSession,
  insertRecommendationRunWithPermits,
  type SignedAcceptancePermit,
} from "./repository.js";

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL.
//
// T-808 (human N6 BLOCK fix, item #4): verifies `getCandidateInvitationsForSession`
// (repository.ts) and its route, `GET /tasks/agents/candidate-invitations`
// — the "候选邀请" state F-806/AC-805 requires "我的接单" to show, which an
// earlier implementation attempt (T-805) simplified away and the human
// reviewer rejected. Endpoint is session-scoped (no `:agentId` path
// param) — a pre-authorized deviation from design.md's draft path shape,
// see this function's/route's own doc comments.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, " +
  "sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xaa83fefc63f0cd0e873a0000c6d07ef7b77e90d1";
const TOKEN_ADDRESS = "0xbb83fefc63f0cd0e873a0000c6d07ef7b77e90d2";
const TEST_DIGEST = "test-digest";

function buildSignedPermit(
  agentId: string,
  agentWalletAddress: string,
  overrides: Partial<SignedAcceptancePermit> = {},
): SignedAcceptancePermit {
  return {
    agentId,
    agentWalletAddress,
    nonce: "1",
    expiry: Math.floor(Date.now() / 1000) + 3600,
    chainId: 31337,
    verifyingContract: "0x1234567890123456789012345678901234567890",
    signature: "0x" + "ab".repeat(65),
    ...overrides,
  };
}

runIfOptedIn(
  "getCandidateInvitationsForSession / GET /tasks/agents/candidate-invitations (integration, T-808)",
  () => {
    let pool: Pool;
    let app: Awaited<ReturnType<typeof buildApp>>;
    const owner = privateKeyToAccount(generatePrivateKey());
    const otherOwner = privateKeyToAccount(generatePrivateKey());

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
      await pool.query("DELETE FROM acceptance_permits");
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

    async function insertAgent(ownerAddress: string): Promise<string> {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        ownerAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
        [ownerAddress],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertAgent: no id returned");
      return id;
    }

    async function insertTask(status = "OPEN"): Promise<string> {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        REQUESTER_ADDRESS,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks
           (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
         VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', $3, 'AUTOMATION')
         RETURNING id`,
        [REQUESTER_ADDRESS, TOKEN_ADDRESS, status],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertTask: no id returned");
      return id;
    }

    async function issueOutstandingInvitation(
      taskId: string,
      agentId: string,
      agentWalletAddress: string,
      overrides: Partial<{ rank: number; slotType: string; nonce: string }> = {},
    ): Promise<string> {
      const { runId } = await insertRecommendationRunWithPermits(pool, {
        taskId,
        algorithmVersion: "v0.1",
        candidateCount: 1,
        inputDigest: TEST_DIGEST,
        candidates: [
          {
            agentId,
            rank: overrides.rank ?? 1,
            slotType: overrides.slotType ?? "TOP_SCORE",
            score: 0.9,
            reasons: ["x"],
          },
        ],
        permits: [
          buildSignedPermit(agentId, agentWalletAddress, { nonce: overrides.nonce ?? "1" }),
        ],
      });
      return runId;
    }

    it("returns an invitation for the caller's own Agent that is a live candidate", async () => {
      const agentId = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, owner.address.toLowerCase());

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.taskId).toBe(taskId);
      expect(result.items[0]?.agentId).toBe(agentId);
      expect(result.items[0]?.rank).toBe(1);
      expect(result.items[0]?.slotType).toBe("TOP_SCORE");
    });

    it("excludes another wallet's candidacy — ownership is the only permission input", async () => {
      const agentId = await insertAgent(otherOwner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, otherOwner.address.toLowerCase());

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("excludes a candidacy once the task has left OPEN, even though the permit is still OUTSTANDING and unexpired", async () => {
      const agentId = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, owner.address.toLowerCase());
      await pool.query(`UPDATE tasks SET status = 'ACCEPTED' WHERE id = $1`, [taskId]);

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });
      expect(result.items).toHaveLength(0);
    });

    it("excludes a candidacy once its permit is CONSUMED", async () => {
      const agentId = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, owner.address.toLowerCase());
      await pool.query(
        `UPDATE acceptance_permits SET status = 'CONSUMED' WHERE task_id = $1 AND agent_id = $2`,
        [taskId, agentId],
      );

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });
      expect(result.items).toHaveLength(0);
    });

    it("excludes a candidacy once its permit is INVALIDATED", async () => {
      const agentId = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, owner.address.toLowerCase());
      await pool.query(
        `UPDATE acceptance_permits SET status = 'INVALIDATED' WHERE task_id = $1 AND agent_id = $2`,
        [taskId, agentId],
      );

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });
      expect(result.items).toHaveLength(0);
    });

    it("excludes a candidacy once its permit has expired, even though status is still OUTSTANDING", async () => {
      const agentId = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, owner.address.toLowerCase());
      await pool.query(
        `UPDATE acceptance_permits SET expiry = $2 WHERE task_id = $1 AND agent_id = $3`,
        [taskId, Math.floor(Date.now() / 1000) - 3600, agentId],
      );

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });
      expect(result.items).toHaveLength(0);
    });

    it("excludes a candidate from a SUPERSEDED recommendation round (only the latest round counts)", async () => {
      const agentA = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();
      // Round 1: agentA is a candidate, then its permit is driven to expired
      // (simulating time passing) so round 2 is allowed to start.
      await issueOutstandingInvitation(taskId, agentA, owner.address.toLowerCase(), {
        nonce: "111",
      });
      await pool.query(`UPDATE acceptance_permits SET expiry = $2 WHERE task_id = $1`, [
        taskId,
        Math.floor(Date.now() / 1000) - 3600,
      ]);

      // Round 2: a different agent (also owned by the same session) is the
      // new candidate. agentA's round-1 row is now bookkept INVALIDATED by
      // insertRecommendationRunWithPermits itself, but this test's point is
      // that even if it had somehow stayed OUTSTANDING, the round-scoping
      // subquery alone would already exclude it since round 1 is no longer
      // "the latest run" for this task.
      const agentB = await insertAgent(owner.address.toLowerCase());
      await issueOutstandingInvitation(taskId, agentB, owner.address.toLowerCase(), {
        nonce: "222",
      });

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.agentId).toBe(agentB);
    });

    it("evaluates same-wallet-multiple-Agents independently — does not conflate two Agents behind one wallet", async () => {
      const agentA = await insertAgent(owner.address.toLowerCase());
      const agentB = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();

      const { runId } = await insertRecommendationRunWithPermits(pool, {
        taskId,
        algorithmVersion: "v0.1",
        candidateCount: 2,
        inputDigest: TEST_DIGEST,
        candidates: [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["a"] },
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.5, reasons: ["b"] },
        ],
        permits: [
          buildSignedPermit(agentA, owner.address.toLowerCase(), { nonce: "301" }),
          buildSignedPermit(agentB, owner.address.toLowerCase(), { nonce: "302" }),
        ],
      });
      expect(runId).toBeTruthy();

      const result = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 20,
      });
      expect(result.total).toBe(2);
      expect(result.items.map((i) => i.agentId).sort()).toEqual([agentA, agentB].sort());
    });

    it("paginates correctly", async () => {
      const agentId = await insertAgent(owner.address.toLowerCase());
      const taskIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const taskId = await insertTask();
        taskIds.push(taskId);
        const agent = i === 0 ? agentId : await insertAgent(owner.address.toLowerCase());
        await issueOutstandingInvitation(taskId, agent, owner.address.toLowerCase(), {
          nonce: String(1000 + i),
        });
      }

      const page1 = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 1,
        pageSize: 2,
      });
      expect(page1.total).toBe(3);
      expect(page1.items).toHaveLength(2);

      const page2 = await getCandidateInvitationsForSession(pool, owner.address.toLowerCase(), {
        page: 2,
        pageSize: 2,
      });
      expect(page2.total).toBe(3);
      expect(page2.items).toHaveLength(1);
    });

    // --- Route-level tests: GET /tasks/agents/candidate-invitations ---

    it("401s an unauthenticated request", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tasks/agents/candidate-invitations",
      });
      expect(response.statusCode).toBe(401);
    });

    it("returns 200 with the caller's own invitations, in the fixed response envelope, when signed in", async () => {
      const agentId = await insertAgent(owner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, owner.address.toLowerCase());
      const token = await login(owner);

      const response = await app.inject({
        method: "GET",
        url: "/tasks/agents/candidate-invitations",
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        taskId,
        agentId,
        category: "writing",
        title: "Task",
        rank: 1,
        slotType: "TOP_SCORE",
      });
      expect(typeof body.items[0].budget).toBe("string");
      expect(typeof body.items[0].deliveryDeadline).toBe("string");
    });

    it("does not leak another wallet's invitations to the signed-in caller", async () => {
      const agentId = await insertAgent(otherOwner.address.toLowerCase());
      const taskId = await insertTask();
      await issueOutstandingInvitation(taskId, agentId, otherOwner.address.toLowerCase());
      const token = await login(owner);

      const response = await app.inject({
        method: "GET",
        url: "/tasks/agents/candidate-invitations",
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toHaveLength(0);
    });
  },
);
