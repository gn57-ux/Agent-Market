import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "./signInMessage.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. Proves AC-404 ("登出后受保护接口拒绝该会话的请求") and the
// `app.requireSession` contract Feature 5-10's own protected routes will
// depend on.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

/** Extracts a named cookie's value from a Set-Cookie response header, the
 * way a real browser (or a manual client re-sending it) would — tests
 * exercise the actual cookie transport, not just the JSON body. */
function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const header of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(header);
    if (match?.[1]) return match[1];
  }
  throw new Error(`Cookie "${name}" not found in Set-Cookie header(s): ${headers.join(" | ")}`);
}

runIfOptedIn("app.requireSession / POST /auth/logout (integration, AC-404)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });

    // Test-only protected route, exercising the exact interface downstream
    // Features (5-10) will use: `{ preHandler: app.requireSession }` plus
    // reading `request.address`. Registered as another `app.register(...)`
    // call (not a direct `app.get(...)` right after `buildApp()` returns)
    // because `app.requireSession` is a decorator added by a plugin
    // registered inside `buildApp()` — Fastify/avvio only guarantees that
    // decorator exists once *this* registration's own plugin function
    // runs, not synchronously the instant `buildApp()` returns.
    await app.register(async (instance) => {
      instance.get("/test-protected", { preHandler: instance.requireSession }, async (request) => {
        return { address: request.address };
      });
    });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
  });

  async function login(): Promise<{ cookieHeader: string; token: string }> {
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
    const token = extractCookieValue(verifyResponse.headers["set-cookie"], "session_token");
    return { cookieHeader: `session_token=${token}`, token };
  }

  it("requireSession rejects a request with no session cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/test-protected" });
    expect(response.statusCode).toBe(401);
  });

  it("requireSession rejects a bogus/unknown session token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: "session_token=not-a-real-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("requireSession accepts a valid session and populates request.address", async () => {
    const { cookieHeader } = await login();

    const response = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().address).toBe(account.address.toLowerCase());
  });

  it("logout revokes the session: requireSession rejects it afterward (AC-404)", async () => {
    const { cookieHeader } = await login();

    const beforeLogout = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: cookieHeader },
    });
    expect(beforeLogout.statusCode).toBe(200);

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });
    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.json()).toEqual({ ok: true });

    const afterLogout = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: cookieHeader },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("logout is idempotent: calling it twice, or with no cookie at all, both succeed", async () => {
    const { cookieHeader } = await login();

    const first = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });
    expect(second.statusCode).toBe(200);

    const noCookie = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(noCookie.statusCode).toBe(200);
  });

  it("logout clears the session cookie in the response", async () => {
    const { cookieHeader } = await login();

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });

    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toContain("session_token=;");
  });

  // T-1601 (Feature 16 N6-blocking verification, item ③): "session/token
  // expiry" is a property of THIS shared `sessions` table + `issueSession`/
  // `verifySession` (session.service.ts) — both `/auth/verify` (SIWE) and
  // `/auth/verify/privy` funnel through the identical `completeLogin.ts` ->
  // `issueSession` call with no provider-specific expiry logic anywhere
  // (session.middleware.ts's own doc comment: "Nothing about how a session
  // is stored... is exposed here"). Driving this via SIWE (headless, no
  // OTP) is therefore real, direct evidence for Privy sessions too, not an
  // approximation — there is no second, Privy-only expiry code path this
  // test could be missing.
  //
  // Uses a controlled DB write to move `expires_at` into the past (same
  // established pattern this codebase already uses for nonce expiry, see
  // routes.integration.test.ts's `UPDATE auth_nonces SET expires_at = now()
  // - interval '1 second'`) rather than waiting out the real 24h TTL —
  // deterministic, no clock mocking against Postgres's own `now()`, and
  // exercises the exact same `expires_at > now()` comparison
  // `verifySession` runs in production.
  it("requireSession rejects an expired session, and a fresh login afterward establishes a genuinely new valid session (T-1601 expiry verification)", async () => {
    const { cookieHeader, token } = await login();

    const beforeExpiry = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: cookieHeader },
    });
    expect(beforeExpiry.statusCode).toBe(200);

    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);

    const afterExpiry = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: cookieHeader },
    });
    expect(afterExpiry.statusCode).toBe(401);

    // The same GET /auth/session restore path the frontend's mount-time
    // effect calls (SessionProvider.tsx) — an expired session must look
    // exactly like "no session" to it, not a distinct error state.
    const sessionCheck = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: cookieHeader },
    });
    expect(sessionCheck.statusCode).toBe(401);

    // Recovery: a fresh login for the SAME address, after the old session
    // expired, must succeed and grant a genuinely new, independently valid
    // session — not be blocked by, or accidentally reuse, the expired one.
    const { cookieHeader: freshCookieHeader, token: freshToken } = await login();
    expect(freshToken).not.toBe(token);

    const afterFreshLogin = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: freshCookieHeader },
    });
    expect(afterFreshLogin.statusCode).toBe(200);
  });

  it("a session revoked via logout does not authorize a second, unrelated session for the same address", async () => {
    // Regression against an overly-broad revoke: logging out of session A
    // must not affect a still-live session B for the same address.
    const sessionA = await login();
    const sessionB = await login();

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: sessionA.cookieHeader },
    });

    const stillWorks = await app.inject({
      method: "GET",
      url: "/test-protected",
      headers: { cookie: sessionB.cookieHeader },
    });
    expect(stillWorks.statusCode).toBe(200);
  });
});
