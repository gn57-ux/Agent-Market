import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { buildSignInMessage } from "../auth/signInMessage.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. Proves T-605's F-608/AC-606/AC-607 behavior
// (pagination, filtering, the public-market-vs-requester status exclusion,
// and history ordering) end to end against a real database, mirroring
// agents/list-detail.integration.test.ts's structure (T-503).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, " +
  "tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE";

const VALID_DRAFT_PAYLOAD = {
  category: "writing",
  skillTags: ["copywriting"],
  title: "Write a landing page",
  description: "Need 500 words of marketing copy.",
  budget: "125500000000000000000",
  deliveryDeadline: "2099-01-01T00:00:00.000Z",
  expertType: "CONTENT_GENERATION",
};

runIfOptedIn(
  "GET /tasks, GET /tasks/:taskId, GET /tasks/:taskId/history (integration, F-608/AC-606/AC-607)",
  () => {
    let pool: Pool;
    let app: ReturnType<typeof buildApp>;
    const requester = privateKeyToAccount(generatePrivateKey());

    beforeAll(async () => {
      // Needed for the "history reflects a real funding-intent transition"
      // test below, which drives DRAFT -> AWAITING_FUNDING through the real
      // POST /tasks/:taskId/funding-intent route — that route's
      // resolveChainConfig() (service.ts) throws on the .env.example
      // zero-address placeholder, so these must be set the same way
      // funding.integration.test.ts's beforeAll does.
      process.env.CHAIN_ID = "31337";
      process.env.TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";
      process.env.YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      process.env.YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";

      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
    });

    afterEach(async () => {
      await pool.query("DELETE FROM task_state_history");
      await pool.query("DELETE FROM chain_events");
      await pool.query("DELETE FROM chain_transactions");
      await pool.query("DELETE FROM task_skills");
      await pool.query("DELETE FROM tasks");
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

    async function createDraft(
      token: string,
      overrides: Record<string, unknown> = {},
    ): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: token },
        payload: { ...VALID_DRAFT_PAYLOAD, ...overrides },
      });
      expect(response.statusCode).toBe(201);
      return response.json().taskId as string;
    }

    it("lists tasks with a default page size of 20 and correct total", async () => {
      const token = await login(requester);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const taskId = await createDraft(token, { title: `Task ${i}` });
        await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [taskId]);
        ids.push(taskId);
      }

      const response = await app.inject({ method: "GET", url: "/tasks" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.items).toHaveLength(3);
    });

    it("paginates across pages with no duplicates or omissions", async () => {
      const token = await login(requester);
      for (let i = 0; i < 5; i += 1) {
        const taskId = await createDraft(token, { title: `Task ${i}` });
        await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [taskId]);
      }

      const page1 = await app.inject({ method: "GET", url: "/tasks?page=1&pageSize=2" });
      const page2 = await app.inject({ method: "GET", url: "/tasks?page=2&pageSize=2" });
      const page3 = await app.inject({ method: "GET", url: "/tasks?page=3&pageSize=2" });

      expect(page1.json().items).toHaveLength(2);
      expect(page2.json().items).toHaveLength(2);
      expect(page3.json().items).toHaveLength(1);
      expect(page1.json().total).toBe(5);
      expect(page3.json().total).toBe(5);

      const allIds = [
        ...page1.json().items.map((t: { taskId: string }) => t.taskId),
        ...page2.json().items.map((t: { taskId: string }) => t.taskId),
        ...page3.json().items.map((t: { taskId: string }) => t.taskId),
      ];
      expect(new Set(allIds).size).toBe(5);
    });

    it("reports the true total even when the requested page is beyond the last populated page", async () => {
      const token = await login(requester);
      for (let i = 0; i < 3; i += 1) {
        const taskId = await createDraft(token, { title: `Task ${i}` });
        await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [taskId]);
      }

      const response = await app.inject({ method: "GET", url: "/tasks?page=99&pageSize=2" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(0);
      expect(body.total).toBe(3);
    });

    it("rejects a pageSize above the 20-item ceiling", async () => {
      const response = await app.inject({ method: "GET", url: "/tasks?pageSize=21" });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an absurdly large page value with 400 instead of a database error (Codex round 2 P2)", async () => {
      // Without a ceiling on `page`, this would compute an OFFSET far
      // outside PostgreSQL's int4 range and error at the database instead
      // of being rejected as a validation error.
      const response = await app.inject({
        method: "GET",
        url: "/tasks?page=1000000000000000000000",
      });
      expect(response.statusCode).toBe(400);
    });

    it("accepts a large but in-bounds page value, returning an empty result set (no database error)", async () => {
      const response = await app.inject({ method: "GET", url: "/tasks?page=1000000" });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toEqual([]);
    });

    it("rejects an invalid status value", async () => {
      const response = await app.inject({ method: "GET", url: "/tasks?status=NOT_A_STATUS" });
      expect(response.statusCode).toBe(400);
    });

    it("filters by category", async () => {
      const token = await login(requester);
      const writingId = await createDraft(token, { title: "Writer", category: "writing" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [writingId]);
      const engineeringId = await createDraft(token, {
        title: "Coder",
        category: "engineering",
      });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [engineeringId]);

      const response = await app.inject({ method: "GET", url: "/tasks?category=engineering" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].title).toBe("Coder");
    });

    it("filters by skillTag without truncating the matched task's own tag list", async () => {
      const token = await login(requester);
      const multiId = await createDraft(token, {
        title: "Multi-skill",
        skillTags: ["copywriting", "editing", "seo"],
      });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [multiId]);
      const otherId = await createDraft(token, { title: "Other", skillTags: ["debugging"] });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [otherId]);

      const response = await app.inject({ method: "GET", url: "/tasks?skillTag=editing" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].title).toBe("Multi-skill");
      expect(body.items[0].skillTags.sort()).toEqual(["copywriting", "editing", "seo"]);
    });

    it("excludes DRAFT/AWAITING_FUNDING from a public query (no requester) — AC-607", async () => {
      const token = await login(requester);
      const draftId = await createDraft(token, { title: "Draft Task" });
      // stays DRAFT

      const awaitingId = await createDraft(token, { title: "Awaiting Task" });
      await pool.query(`UPDATE tasks SET status = 'AWAITING_FUNDING' WHERE id = $1`, [awaitingId]);

      const openId = await createDraft(token, { title: "Open Task" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [openId]);

      const response = await app.inject({ method: "GET", url: "/tasks" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const ids = body.items.map((t: { taskId: string }) => t.taskId);
      expect(ids).toContain(openId);
      expect(ids).not.toContain(draftId);
      expect(ids).not.toContain(awaitingId);
      expect(body.total).toBe(1);
    });

    it('includes DRAFT/AWAITING_FUNDING when requester is provided AND the caller is authenticated as that same requester ("我的发布") — AC-606', async () => {
      const token = await login(requester);
      const draftId = await createDraft(token, { title: "Draft Task" });
      const awaitingId = await createDraft(token, { title: "Awaiting Task" });
      await pool.query(`UPDATE tasks SET status = 'AWAITING_FUNDING' WHERE id = $1`, [awaitingId]);
      const openId = await createDraft(token, { title: "Open Task" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [openId]);

      const response = await app.inject({
        method: "GET",
        url: `/tasks?requester=${requester.address}`,
        // Authenticated AS the same requester being queried — this is the
        // "我的发布" case AC-606 describes. Codex review, T-605 round 1, P1:
        // this test previously sent no session cookie at all and still
        // expected drafts back, which was only passing because of the bug
        // being fixed here (see the two tests below for the corrected,
        // anonymous-caller behavior).
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const ids = body.items.map((t: { taskId: string }) => t.taskId);
      expect(ids).toContain(draftId);
      expect(ids).toContain(awaitingId);
      expect(ids).toContain(openId);
      expect(body.total).toBe(3);
    });

    it("does NOT include DRAFT/AWAITING_FUNDING for an anonymous (no session) requester-scoped query, even though the address matches (Codex round 1 P1)", async () => {
      const token = await login(requester);
      const draftId = await createDraft(token, { title: "Draft Task" });
      const awaitingId = await createDraft(token, { title: "Awaiting Task" });
      await pool.query(`UPDATE tasks SET status = 'AWAITING_FUNDING' WHERE id = $1`, [awaitingId]);
      const openId = await createDraft(token, { title: "Open Task" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [openId]);

      // No `cookies` at all — this is exactly the exploit Codex's review
      // described: an anonymous caller passing someone else's (real,
      // publicly-known) address as `requester` must not be able to
      // enumerate that address's unpublished drafts.
      const response = await app.inject({
        method: "GET",
        url: `/tasks?requester=${requester.address}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const ids = body.items.map((t: { taskId: string }) => t.taskId);
      expect(ids).not.toContain(draftId);
      expect(ids).not.toContain(awaitingId);
      expect(ids).toContain(openId);
      expect(body.total).toBe(1);
    });

    it("does NOT include DRAFT/AWAITING_FUNDING when the authenticated caller is a DIFFERENT address than the requester being queried (Codex round 1 P1)", async () => {
      const stranger = privateKeyToAccount(generatePrivateKey());
      const token = await login(requester);
      const strangerToken = await login(stranger);
      const draftId = await createDraft(token, { title: "Draft Task" });
      const openId = await createDraft(token, { title: "Open Task" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [openId]);

      // Authenticated, but as `stranger` — not as the `requester` address
      // being queried. A valid session must not be enough on its own; it
      // has to match the exact address the caller is asking about.
      const response = await app.inject({
        method: "GET",
        url: `/tasks?requester=${requester.address}`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const ids = body.items.map((t: { taskId: string }) => t.taskId);
      expect(ids).not.toContain(draftId);
      expect(ids).toContain(openId);
      expect(body.total).toBe(1);
    });

    it("a requester-scoped query combined with an explicit status filter shows exactly that status, including DRAFT, when authenticated as that requester", async () => {
      const token = await login(requester);
      const draftId = await createDraft(token, { title: "Draft Task" });
      const openId = await createDraft(token, { title: "Open Task" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [openId]);

      const response = await app.inject({
        method: "GET",
        url: `/tasks?requester=${requester.address}&status=DRAFT`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].taskId).toBe(draftId);
    });

    it("an anonymous caller passing status=DRAFT explicitly still gets zero results, not an error (Codex round 1 P1)", async () => {
      const token = await login(requester);
      await createDraft(token, { title: "Draft Task" });

      const response = await app.inject({
        method: "GET",
        url: `/tasks?requester=${requester.address}&status=DRAFT`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().total).toBe(0);
    });

    it("returns task detail (authenticated as owner) and 404 for a nonexistent id", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      // Still DRAFT — must be authenticated as the owner to see it (Codex
      // review, T-605 round 1, P1). See the dedicated visibility tests
      // below for the anonymous/wrong-caller cases.
      const response = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().taskId).toBe(taskId);

      const missing = await app.inject({
        method: "GET",
        url: "/tasks/00000000-0000-0000-0000-000000000000",
      });
      expect(missing.statusCode).toBe(404);
    });

    it("rejects a malformed taskId (not a UUID)", async () => {
      const response = await app.inject({ method: "GET", url: "/tasks/not-a-uuid" });
      expect(response.statusCode).toBe(400);
    });

    it("hides an unpublished (DRAFT/AWAITING_FUNDING) task's detail as a 404 for an anonymous caller — indistinguishable from a nonexistent id (Codex round 1 P1)", async () => {
      const token = await login(requester);
      const draftId = await createDraft(token, { title: "Draft Task" });

      const anonymous = await app.inject({ method: "GET", url: `/tasks/${draftId}` });
      expect(anonymous.statusCode).toBe(404);

      const stranger = privateKeyToAccount(generatePrivateKey());
      const strangerToken = await login(stranger);
      const wrongCaller = await app.inject({
        method: "GET",
        url: `/tasks/${draftId}`,
        cookies: { session_token: strangerToken },
      });
      expect(wrongCaller.statusCode).toBe(404);
    });

    it("shows a PUBLISHED (OPEN) task's detail to an anonymous caller normally", async () => {
      const token = await login(requester);
      const openId = await createDraft(token, { title: "Open Task" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [openId]);

      const response = await app.inject({ method: "GET", url: `/tasks/${openId}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().taskId).toBe(openId);
    });

    it("returns the DRAFT -> AWAITING_FUNDING -> OPEN history in chronological order (via T-604's real funding flow)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      const intentResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-intent`,
        cookies: { session_token: token },
      });
      expect(intentResponse.statusCode).toBe(200);

      // Still AWAITING_FUNDING at this point — history of an unpublished
      // task is gated the same way its detail is (Codex round 1 P1).
      const response = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}/history`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ fromStatus: "DRAFT", toStatus: "AWAITING_FUNDING" });
      expect(typeof body.items[0].occurredAt).toBe("string");

      // Ordering assertion: occurredAt values are non-decreasing.
      const timestamps = body.items.map((entry: { occurredAt: string }) =>
        new Date(entry.occurredAt).getTime(),
      );
      const sorted = [...timestamps].sort((a, b) => a - b);
      expect(timestamps).toEqual(sorted);
    });

    it("returns 404 for history of a nonexistent taskId", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tasks/00000000-0000-0000-0000-000000000000/history",
      });
      expect(response.statusCode).toBe(404);
    });

    it("hides an unpublished task's history as a 404 for an anonymous caller (Codex round 1 P1)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      const response = await app.inject({ method: "GET", url: `/tasks/${taskId}/history` });
      expect(response.statusCode).toBe(404);
    });

    it("returns an empty items array for a task with no recorded transitions yet (still DRAFT, authenticated as owner)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      const response = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}/history`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toEqual([]);
    });

    // T-805: `acceptedBy` filters `tasks.accepted_agent_address` directly
    // via SQL rather than driving the full acceptance flow (dispatch
    // matching / acceptance-permits / on-chain verification) — that flow is
    // already covered end to end by acceptance.integration.test.ts; this
    // suite only needs to prove GET /tasks' filter and GET /tasks/:taskId's
    // field exposure, both of which only depend on the column values being
    // set, not on how they got there.
    it("filters by acceptedBy, returning only tasks accepted by that address (T-805)", async () => {
      const token = await login(requester);
      const agentA = privateKeyToAccount(generatePrivateKey());
      const agentB = privateKeyToAccount(generatePrivateKey());

      const acceptedByAId = await createDraft(token, { title: "Accepted by A" });
      await pool.query(
        `UPDATE tasks SET status = 'ACCEPTED', accepted_agent_address = $2, accepted_at = now()
         WHERE id = $1`,
        [acceptedByAId, agentA.address.toLowerCase()],
      );

      const acceptedByBId = await createDraft(token, { title: "Accepted by B" });
      await pool.query(
        `UPDATE tasks SET status = 'ACCEPTED', accepted_agent_address = $2, accepted_at = now()
         WHERE id = $1`,
        [acceptedByBId, agentB.address.toLowerCase()],
      );

      const stillOpenId = await createDraft(token, { title: "Still open" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [stillOpenId]);

      const response = await app.inject({
        method: "GET",
        url: `/tasks?acceptedBy=${agentA.address}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.items[0].taskId).toBe(acceptedByAId);
      expect(body.items[0].acceptedAgentAddress).toBe(agentA.address.toLowerCase());
    });

    it("GET /tasks/:taskId includes acceptedAgentAddress/acceptedAt — null when not accepted, real values once accepted (T-805)", async () => {
      const token = await login(requester);
      const openId = await createDraft(token, { title: "Not yet accepted" });
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [openId]);

      const beforeAcceptance = await app.inject({ method: "GET", url: `/tasks/${openId}` });
      expect(beforeAcceptance.statusCode).toBe(200);
      expect(beforeAcceptance.json().acceptedAgentAddress).toBeNull();
      expect(beforeAcceptance.json().acceptedAt).toBeNull();

      const agent = privateKeyToAccount(generatePrivateKey());
      await pool.query(
        `UPDATE tasks SET status = 'ACCEPTED', accepted_agent_address = $2, accepted_at = now()
         WHERE id = $1`,
        [openId, agent.address.toLowerCase()],
      );

      const afterAcceptance = await app.inject({ method: "GET", url: `/tasks/${openId}` });
      expect(afterAcceptance.statusCode).toBe(200);
      expect(afterAcceptance.json().acceptedAgentAddress).toBe(agent.address.toLowerCase());
      expect(typeof afterAcceptance.json().acceptedAt).toBe("string");
    });
  },
);
