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
 * F-1606/T-1607 — real end-to-end coverage for `app.requireAdmin`, `POST
 * /admin/roles`, `DELETE /admin/roles/:address` (AC-1606). Real HTTP
 * (`app.inject`), real Postgres, real SIWE signatures throughout.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn(
  "admin roles: app.requireAdmin / POST+DELETE /admin/roles (integration, T-1607, AC-1606)",
  () => {
    let pool: Pool;
    let app: ReturnType<typeof buildApp>;
    const admin = privateKeyToAccount(generatePrivateKey());
    const nonAdmin = privateKeyToAccount(generatePrivateKey());
    const target = privateKeyToAccount(generatePrivateKey());

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });
    });

    afterAll(async () => {
      await pool.query(
        "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agent_review_audit_logs, agents, sessions, auth_nonces, users, consumed_privy_tokens, admin_role_audit_logs, admin_roles, schema_migrations CASCADE",
      );
      await pool.end();
    });

    afterEach(async () => {
      await pool.query("DELETE FROM admin_role_audit_logs");
      await pool.query("DELETE FROM admin_roles");
      await pool.query("DELETE FROM sessions");
      await pool.query("DELETE FROM auth_nonces");
      await pool.query("DELETE FROM users");
    });

    function extractCookieValue(setCookieHeader: string | string[] | undefined): string {
      const headers = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : setCookieHeader
          ? [setCookieHeader]
          : [];
      for (const header of headers) {
        const match = /session_token=([^;]+)/.exec(header);
        if (match?.[1]) return match[1];
      }
      throw new Error(`session_token cookie not found in: ${headers.join(" | ")}`);
    }

    async function loginAs(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
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
      const token = extractCookieValue(verifyResponse.headers["set-cookie"]);
      return `session_token=${token}`;
    }

    async function seedAdmin(account: ReturnType<typeof privateKeyToAccount>): Promise<void> {
      const address = account.address.toLowerCase();
      await pool.query(`INSERT INTO admin_roles (address, granted_by) VALUES ($1, $1)`, [address]);
    }

    it("no session: both routes reject with 401", async () => {
      const post = await app.inject({
        method: "POST",
        url: "/admin/roles",
        payload: { address: target.address },
      });
      expect(post.statusCode).toBe(401);

      const del = await app.inject({
        method: "DELETE",
        url: `/admin/roles/${target.address}`,
      });
      expect(del.statusCode).toBe(401);
    });

    it("a valid session that isn't an admin: both routes reject with 403", async () => {
      const cookie = await loginAs(nonAdmin);

      const post = await app.inject({
        method: "POST",
        url: "/admin/roles",
        payload: { address: target.address },
        headers: { cookie },
      });
      expect(post.statusCode).toBe(403);

      const del = await app.inject({
        method: "DELETE",
        url: `/admin/roles/${target.address}`,
        headers: { cookie },
      });
      expect(del.statusCode).toBe(403);
    });

    it("an admin can grant a new admin; the grant is persisted with an audit row, and the target can immediately act as admin themselves", async () => {
      await seedAdmin(admin);
      const adminCookie = await loginAs(admin);

      const grantResponse = await app.inject({
        method: "POST",
        url: "/admin/roles",
        payload: { address: target.address },
        headers: { cookie: adminCookie },
      });
      expect(grantResponse.statusCode).toBe(201);
      const body = grantResponse.json();
      expect(body.address).toBe(target.address.toLowerCase());
      expect(body.grantedBy).toBe(admin.address.toLowerCase());

      const { rows: roleRows } = await pool.query(
        `SELECT address, granted_by FROM admin_roles WHERE address = $1`,
        [target.address.toLowerCase()],
      );
      expect(roleRows).toHaveLength(1);
      expect(roleRows[0].granted_by).toBe(admin.address.toLowerCase());

      const { rows: auditRows } = await pool.query(
        `SELECT target_address, action, actor_address FROM admin_role_audit_logs WHERE target_address = $1`,
        [target.address.toLowerCase()],
      );
      expect(auditRows).toEqual([
        {
          target_address: target.address.toLowerCase(),
          action: "GRANT",
          actor_address: admin.address.toLowerCase(),
        },
      ]);

      // AC-1606's second half: "之后可通过 POST /admin/roles 常规授予更多管理员" —
      // the newly-granted admin's session, obtained independently AFTER the
      // grant, must itself now pass app.requireAdmin.
      const targetCookie = await loginAs(target);
      const chainedGrant = await app.inject({
        method: "POST",
        url: "/admin/roles",
        payload: { address: nonAdmin.address },
        headers: { cookie: targetCookie },
      });
      expect(chainedGrant.statusCode).toBe(201);
    });

    it("granting an address that's already an admin returns 409, writes no duplicate row or audit entry", async () => {
      await seedAdmin(admin);
      const adminCookie = await loginAs(admin);
      await seedAdmin(target);

      const response = await app.inject({
        method: "POST",
        url: "/admin/roles",
        payload: { address: target.address },
        headers: { cookie: adminCookie },
      });
      expect(response.statusCode).toBe(409);

      const { rows } = await pool.query(
        `SELECT * FROM admin_role_audit_logs WHERE target_address = $1`,
        [target.address.toLowerCase()],
      );
      expect(rows).toEqual([]);
    });

    it("an admin can revoke another admin; the row and a REVOKE audit entry are written, and the revoked address immediately loses admin access", async () => {
      await seedAdmin(admin);
      await seedAdmin(target);
      const adminCookie = await loginAs(admin);
      const targetCookie = await loginAs(target);

      const revokeResponse = await app.inject({
        method: "DELETE",
        url: `/admin/roles/${target.address}`,
        headers: { cookie: adminCookie },
      });
      expect(revokeResponse.statusCode).toBe(204);

      const { rows: roleRows } = await pool.query(`SELECT * FROM admin_roles WHERE address = $1`, [
        target.address.toLowerCase(),
      ]);
      expect(roleRows).toEqual([]);

      const { rows: auditRows } = await pool.query(
        `SELECT action FROM admin_role_audit_logs WHERE target_address = $1`,
        [target.address.toLowerCase()],
      );
      expect(auditRows).toEqual([{ action: "REVOKE" }]);

      // The revoked address's own still-valid session must be re-checked
      // against the CURRENT table state, not any cached "was admin" fact.
      const revokedTriesAgain = await app.inject({
        method: "DELETE",
        url: `/admin/roles/${admin.address}`,
        headers: { cookie: targetCookie },
      });
      expect(revokedTriesAgain.statusCode).toBe(403);
    });

    it("revoking an address that isn't an admin returns 404", async () => {
      await seedAdmin(admin);
      const adminCookie = await loginAs(admin);

      const response = await app.inject({
        method: "DELETE",
        url: `/admin/roles/${target.address}`,
        headers: { cookie: adminCookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it("revoking the only remaining admin's own session returns 409, leaves them still admin", async () => {
      await seedAdmin(admin);
      const adminCookie = await loginAs(admin);

      const response = await app.inject({
        method: "DELETE",
        url: `/admin/roles/${admin.address}`,
        headers: { cookie: adminCookie },
      });
      expect(response.statusCode).toBe(409);

      const { rows } = await pool.query(`SELECT address FROM admin_roles`);
      expect(rows).toEqual([{ address: admin.address.toLowerCase() }]);
    });

    it("rejects a malformed address with 400 before touching the database", async () => {
      await seedAdmin(admin);
      const adminCookie = await loginAs(admin);

      const response = await app.inject({
        method: "POST",
        url: "/admin/roles",
        payload: { address: "not-an-address" },
        headers: { cookie: adminCookie },
      });
      expect(response.statusCode).toBe(400);
    });
  },
);
