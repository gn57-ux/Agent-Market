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
        "DROP TABLE IF EXISTS agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
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
