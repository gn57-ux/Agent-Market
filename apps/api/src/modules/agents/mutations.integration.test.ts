import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { computeCredentialRef } from "./credential.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. Proves T-504's F-503 (partial edit), F-504
// (activate/deactivate), and AC-505 (ownership enforcement, status
// filterable via GET /agents) end to end against a real database.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn(
  "PATCH /agents/:agentId, activate/deactivate (integration, F-503/F-504/AC-505)",
  () => {
    let pool: Pool;
    let app: ReturnType<typeof buildApp>;
    const owner = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });
    });

    afterAll(async () => {
      await pool.query(
        "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE",
      );
      await pool.end();
    });

    afterEach(async () => {
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

    async function createAgent(token: string): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: token },
        payload: {
          name: "Original Name",
          description: "Original description",
          category: "writing",
          skillTags: ["copywriting"],
          payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
          pricingType: "FREE",
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json().agentId;
    }

    it("applies a partial edit, leaving unspecified fields unchanged", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);

      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { name: "Renamed" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe("Renamed");
      expect(body.description).toBe("Original description");
      expect(body.category).toBe("writing");
      expect(body.skillTags).toEqual(["copywriting"]);
    });

    it("clears an optional field via explicit null, distinct from omitting it (Codex round 1 P2)", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);

      const setValue = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { authorBio: "A real bio", pricingModel: "per-task", referencePrice: "12.5" },
      });
      expect(setValue.statusCode).toBe(200);
      expect(setValue.json().authorBio).toBe("A real bio");

      // Omitting a field entirely must NOT clear it — this PATCH only
      // touches `name`, so authorBio/pricingModel/referencePrice must
      // survive untouched.
      const unrelatedEdit = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { name: "Still Has A Bio" },
      });
      expect(unrelatedEdit.json().authorBio).toBe("A real bio");
      expect(unrelatedEdit.json().pricingModel).toBe("per-task");

      const clear = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { authorBio: null, pricingModel: null, referencePrice: null },
      });
      expect(clear.statusCode).toBe(200);
      const body = clear.json();
      expect(body.authorBio).toBeNull();
      expect(body.pricingModel).toBeNull();
      expect(body.referencePrice).toBeNull();
      // name from the previous PATCH must still be intact — clearing other
      // fields must not reset unrelated columns.
      expect(body.name).toBe("Still Has A Bio");
    });

    // Feature 12 (agent-task-fields-credentials), T-1201, AC-1201/AC-1202.
    // GET is called with the owner's own session cookie (T-1203 round-2
    // Finding 1 fix — see the dedicated visibility tests below — means
    // credentialRef is only ever present in the response for the Agent's
    // own owner; an anonymous GET here would see the field omitted
    // entirely, not `null`).
    it("defaults protocolVersion to 'v1' and credentialRef to null when credentialEnabled is omitted at creation", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);

      const response = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().protocolVersion).toBe("v1");
      expect(response.json().credentialRef).toBeNull();
    });

    // T-1300: credentialRef is no longer owner-chosen free text — it's a
    // toggle (`credentialEnabled`) the server resolves into the one
    // deterministic reference this Agent's own real id can ever produce
    // (env://AGENT_<id, dashes stripped, hex uppercased>). This closes the
    // front-running vector Codex found in the pre-fix free-text scheme (an
    // attacker could pre-claim env://AGENT_<victim's public id> on their
    // own Agent before the operator ever provisioned it).
    it("accepts and round-trips a computed credentialRef through create, GET detail, and GET list (as the owner)", async () => {
      const token = await login(owner);
      const createResponse = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: token },
        payload: {
          name: "Agent With Credential",
          description: "desc",
          category: "writing",
          payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
          pricingType: "FREE",
          credentialEnabled: true,
        },
      });
      expect(createResponse.statusCode).toBe(201);
      const agentId = createResponse.json().agentId;
      const expectedRef = computeCredentialRef(agentId);

      const detail = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
      });
      expect(detail.json().credentialRef).toBe(expectedRef);

      const list = await app.inject({
        method: "GET",
        url: "/agents",
        cookies: { session_token: token },
      });
      const listed = list
        .json()
        .items.find((item: { agentId: string }) => item.agentId === agentId);
      expect(listed?.credentialRef).toBe(expectedRef);
    });

    // T-1203 round-2 Finding 1 (P1): credentialRef must never reach a caller
    // who isn't the Agent's own owner — previously any anonymous or stranger
    // caller could read the exact reference string and paste it into their
    // own Agent to borrow the victim's real credential via the diagnostic
    // endpoint. `undefined` is asserted (key omitted), not `null` — the
    // response must not even reveal whether a credential is configured.
    it("hides credentialRef from GET detail/list for anonymous and non-owner callers, even when a real value is set", async () => {
      const token = await login(owner);
      const createResponse = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: token },
        payload: {
          name: "Agent With Secret Credential",
          description: "desc",
          category: "writing",
          payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
          pricingType: "FREE",
          credentialEnabled: true,
        },
      });
      expect(createResponse.statusCode).toBe(201);
      const agentId = createResponse.json().agentId;

      const anonymousDetail = await app.inject({ method: "GET", url: `/agents/${agentId}` });
      expect(anonymousDetail.json().credentialRef).toBeUndefined();

      const strangerToken = await login(stranger);
      const strangerDetail = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: strangerToken },
      });
      expect(strangerDetail.json().credentialRef).toBeUndefined();

      const anonymousList = await app.inject({ method: "GET", url: "/agents" });
      const listedForAnonymous = anonymousList
        .json()
        .items.find((item: { agentId: string }) => item.agentId === agentId);
      expect(listedForAnonymous?.credentialRef).toBeUndefined();

      const strangerList = await app.inject({
        method: "GET",
        url: "/agents",
        cookies: { session_token: strangerToken },
      });
      const listedForStranger = strangerList
        .json()
        .items.find((item: { agentId: string }) => item.agentId === agentId);
      expect(listedForStranger?.credentialRef).toBeUndefined();
    });

    // T-1300 (replaces the old free-text-reuse test): two different Agents
    // enabling their credential each get their OWN distinct, non-colliding
    // reference — the front-running/reuse vector a shared free-text string
    // used to allow is now structurally impossible, proven here across two
    // real Agents rather than asserted about the schema alone.
    it("gives two different Agents two different, non-colliding computed credentialRefs", async () => {
      const token = await login(owner);
      const first = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: token },
        payload: {
          name: "First Agent",
          description: "desc",
          category: "writing",
          payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
          pricingType: "FREE",
          credentialEnabled: true,
        },
      });
      expect(first.statusCode).toBe(201);

      const strangerToken = await login(stranger);
      const second = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: strangerToken },
        payload: {
          name: "Second Agent",
          description: "desc",
          category: "writing",
          payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
          pricingType: "FREE",
          credentialEnabled: true,
        },
      });
      expect(second.statusCode).toBe(201);
      expect(computeCredentialRef(first.json().agentId)).not.toBe(
        computeCredentialRef(second.json().agentId),
      );
    });

    // T-1300: an attacker cannot "front-run" a victim's future reference —
    // there is no free-text input left to submit at all. This proves the
    // API boundary itself: attempting to send a raw string is simply
    // ignored by the toggle schema (a non-boolean value is a 400, not a
    // silently-accepted string).
    it("rejects a non-boolean credentialEnabled value (400) — there is no free-text credentialRef input anymore", async () => {
      const token = await login(owner);
      const response = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: token },
        payload: {
          name: "Attempted Free Text",
          description: "desc",
          category: "writing",
          payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
          pricingType: "FREE",
          credentialEnabled: "env://AGENT_SOME_VICTIM_ID",
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it("PATCH toggles credentialEnabled on and off, always resolving to this Agent's own computed reference", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);
      const expectedRef = computeCredentialRef(agentId);

      const setValue = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { credentialEnabled: true },
      });
      expect(setValue.statusCode).toBe(200);
      expect(setValue.json().credentialRef).toBe(expectedRef);

      // Omitting the field entirely must not clear it.
      const unrelatedEdit = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { name: "Still Has A Credential" },
      });
      expect(unrelatedEdit.json().credentialRef).toBe(expectedRef);

      const clear = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { credentialEnabled: false },
      });
      expect(clear.statusCode).toBe(200);
      expect(clear.json().credentialRef).toBeNull();
    });

    it("rejects a protocolVersion other than 'v1' (400)", async () => {
      const token = await login(owner);
      const response = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: token },
        payload: {
          name: "Future Protocol Agent",
          description: "desc",
          category: "writing",
          payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
          pricingType: "FREE",
          protocolVersion: "v2",
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it("PATCH stores and returns a high-precision referencePrice byte-identical (Codex round 3 blocking)", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);
      const highPrecisionPrice = "0.100000000000000000001";

      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { referencePrice: highPrecisionPrice },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().referencePrice).toBe(highPrecisionPrice);

      // An unrelated edit that doesn't mention referencePrice must not
      // disturb the stored precision either.
      const unrelatedEdit = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { name: "Renamed Again" },
      });
      expect(unrelatedEdit.json().referencePrice).toBe(highPrecisionPrice);
    });

    it("replaces the full skillTags set when provided", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);

      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
        payload: { skillTags: ["seo", "editing"] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().skillTags.sort()).toEqual(["editing", "seo"]);
    });

    it("rejects an edit from a non-owner session (AC-505)", async () => {
      const ownerToken = await login(owner);
      const agentId = await createAgent(ownerToken);
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        cookies: { session_token: strangerToken },
        payload: { name: "Hijacked" },
      });
      expect(response.statusCode).toBe(403);

      const stillOriginal = await app.inject({ method: "GET", url: `/agents/${agentId}` });
      expect(stillOriginal.json().name).toBe("Original Name");
    });

    it("returns 404 editing a nonexistent agent", async () => {
      const token = await login(owner);
      const response = await app.inject({
        method: "PATCH",
        url: "/agents/00000000-0000-0000-0000-000000000000",
        cookies: { session_token: token },
        payload: { name: "Ghost" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("rejects PATCH with no session cookie", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);

      const response = await app.inject({
        method: "PATCH",
        url: `/agents/${agentId}`,
        payload: { name: "No Auth" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("deactivates then reactivates an Agent, excludable via GET /agents?status=ACTIVE (AC-505)", async () => {
      const token = await login(owner);
      const agentId = await createAgent(token);

      const deactivate = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/deactivate`,
        cookies: { session_token: token },
      });
      expect(deactivate.statusCode).toBe(200);
      expect(deactivate.json().status).toBe("INACTIVE");

      // Unfiltered listing still shows it (its status is reported as-is,
      // not hidden) — the actual exclusion is via the status query param.
      const unfiltered = await app.inject({ method: "GET", url: "/agents" });
      const foundUnfiltered = unfiltered
        .json()
        .items.find((a: { agentId: string }) => a.agentId === agentId);
      expect(foundUnfiltered?.status).toBe("INACTIVE");

      // AC-505: filtering by status=ACTIVE excludes the deactivated Agent.
      const activeOnly = await app.inject({ method: "GET", url: "/agents?status=ACTIVE" });
      const foundInActiveOnly = activeOnly
        .json()
        .items.find((a: { agentId: string }) => a.agentId === agentId);
      expect(foundInActiveOnly).toBeUndefined();
      expect(activeOnly.json().total).toBe(0);

      // Symmetrically, status=INACTIVE finds exactly this Agent.
      const inactiveOnly = await app.inject({ method: "GET", url: "/agents?status=INACTIVE" });
      expect(inactiveOnly.json().total).toBe(1);
      expect(inactiveOnly.json().items[0]?.agentId).toBe(agentId);

      const activate = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/activate`,
        cookies: { session_token: token },
      });
      expect(activate.statusCode).toBe(200);
      expect(activate.json().status).toBe("ACTIVE");

      // Reactivated: now shows up under status=ACTIVE again.
      const activeOnlyAfterReactivate = await app.inject({
        method: "GET",
        url: "/agents?status=ACTIVE",
      });
      expect(
        activeOnlyAfterReactivate
          .json()
          .items.some((a: { agentId: string }) => a.agentId === agentId),
      ).toBe(true);
    });

    it("rejects deactivate from a non-owner session (AC-505)", async () => {
      const ownerToken = await login(owner);
      const agentId = await createAgent(ownerToken);
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "POST",
        url: `/agents/${agentId}/deactivate`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(403);

      const stillActive = await app.inject({ method: "GET", url: `/agents/${agentId}` });
      expect(stillActive.json().status).toBe("ACTIVE");
    });

    it("returns 404 activating a nonexistent agent", async () => {
      const token = await login(owner);
      const response = await app.inject({
        method: "POST",
        url: "/agents/00000000-0000-0000-0000-000000000000/activate",
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(404);
    });
  },
);

/**
 * `app.inject()` (used throughout this file above) never sends a
 * Content-Type header unless a payload is given — so it could never have
 * reproduced the real bug found in T-505's manual browser walkthrough:
 * apps/web's apiFetch was sending Content-Type: application/json on EVERY
 * request, including bodyless POSTs like activate/deactivate, and Fastify
 * rejects an empty body under that content-type as invalid JSON — a 400
 * before the route handler ever ran. This suite starts the real app
 * listening on a real TCP port and issues actual `fetch()` calls (real
 * HTTP, not Fastify's in-process injection) to prove Fastify's actual
 * behavior for both the broken and the fixed request shape, against a
 * real database.
 */
runIfOptedIn("activate/deactivate over real HTTP (integration, T-505 P1 regression)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let baseUrl: string;
  const owner = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
  });

  async function loginOverHttp(): Promise<string> {
    const nonceResponse = await fetch(`${baseUrl}/auth/nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: owner.address }),
    });
    const { nonce, issuedAt, expiresAt } = await nonceResponse.json();
    const message = buildSignInMessage({
      domain: "localhost",
      address: owner.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await owner.signMessage({ message });
    const verifyResponse = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: owner.address, signature, nonce }),
    });
    const setCookie = verifyResponse.headers.get("set-cookie");
    const match = /session_token=([^;]+)/.exec(String(setCookie));
    if (!match?.[1]) throw new Error("no session_token cookie in verify response");
    return match[1];
  }

  async function createAgentOverHttp(cookie: string): Promise<string> {
    const response = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `session_token=${cookie}` },
      body: JSON.stringify({
        name: "HTTP Test Agent",
        description: "desc",
        category: "writing",
        skillTags: ["copywriting"],
        payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
        pricingType: "FREE",
      }),
    });
    const body = await response.json();
    return body.agentId;
  }

  it("reproduces the exact browser bug: Content-Type: application/json with no body is rejected before the route runs", async () => {
    const cookie = await loginOverHttp();
    const agentId = await createAgentOverHttp(cookie);

    const response = await fetch(`${baseUrl}/agents/${agentId}/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `session_token=${cookie}` },
    });
    // This is Fastify's real rejection — the same one the browser
    // walkthrough hit — not this project's own error shape, confirming the
    // request never reached the agents route at all.
    expect(response.status).toBe(400);
  });

  it("activate/deactivate succeed over real HTTP when no Content-Type is sent for the bodyless request (the fix)", async () => {
    const cookie = await loginOverHttp();
    const agentId = await createAgentOverHttp(cookie);

    const deactivateResponse = await fetch(`${baseUrl}/agents/${agentId}/deactivate`, {
      method: "POST",
      headers: { cookie: `session_token=${cookie}` },
    });
    expect(deactivateResponse.status).toBe(200);
    expect((await deactivateResponse.json()).status).toBe("INACTIVE");

    const activeOnlyList = await fetch(`${baseUrl}/agents?status=ACTIVE`, {
      headers: { cookie: `session_token=${cookie}` },
    });
    const activeOnlyBody = await activeOnlyList.json();
    expect(activeOnlyBody.items.some((a: { agentId: string }) => a.agentId === agentId)).toBe(
      false,
    );

    const activateResponse = await fetch(`${baseUrl}/agents/${agentId}/activate`, {
      method: "POST",
      headers: { cookie: `session_token=${cookie}` },
    });
    expect(activateResponse.status).toBe(200);
    expect((await activateResponse.json()).status).toBe("ACTIVE");
  });
});
