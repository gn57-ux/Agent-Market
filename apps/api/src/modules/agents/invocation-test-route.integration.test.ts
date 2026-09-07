import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1203's real end-to-end verification of
// POST /agents/:agentId/invocation-test — ownership enforcement (F-1204's
// diagnostic endpoint requires the caller be the Agent's own owner) plus a
// real call through to a real local HTTP server, proving the whole chain
// (route → service → callAgent → real network) works, not just
// invocation-client.ts in isolation.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const ENV_VAR_NAME = "AGENT_MARKET_TEST_ROUTE_CREDENTIAL";

runIfOptedIn("POST /agents/:agentId/invocation-test (integration, F-1204/T-1203)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let server: Server | undefined;
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    delete process.env[ENV_VAR_NAME];
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
  });

  function listen(handler: RequestListener): Promise<string> {
    return new Promise((resolve) => {
      server = createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") {
          resolve(`http://127.0.0.1:${address.port}`);
        }
      });
    });
  }

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

  async function createAgent(token: string, overrides: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: {
        name: "Invocation Test Agent",
        description: "desc",
        category: "writing",
        payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
        pricingType: "FREE",
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().agentId as string;
  }

  // Codex review (T-1203 round 1, P1 SSRF/plaintext-credential fixes): a
  // real local test server is necessarily plain http:// on a loopback
  // address — exactly what the fix now rejects. This is therefore a real,
  // unmocked, end-to-end proof (through the actual route, not just
  // invocation-client.ts in isolation) that the safety check is genuinely
  // wired into the diagnostic endpoint, not only unit-tested in isolation.
  // A successful full round-trip (the pre-fix version of this test) is
  // covered instead by invocation-client.test.ts's own dedicated
  // `skipDestinationCheck` tests — an https:// + non-loopback real target
  // isn't available in this local test environment.
  it("rejects a real call through invocationUrl when it isn't https:// (SSRF/plaintext-credential fix, real end-to-end, no mocks)", async () => {
    let serverWasCalled = false;
    const url = await listen((req, res) => {
      serverWasCalled = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ echoed: true }));
    });
    const token = await login(owner);
    // T-1300: credentialRef is no longer owner-chosen — `credentialEnabled`
    // toggles it to the server-computed reference for this Agent's own
    // real id, known only after creation. This test never actually reaches
    // credential resolution (it fails earlier on the https:// check), so
    // the env var doesn't need to be genuinely set here.
    const agentId = await createAgent(token, {
      invocationUrl: url,
      credentialEnabled: true,
    });

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/invocation-test`,
      cookies: { session_token: token },
      payload: { payload: { probe: true } },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("https://");
    expect(serverWasCalled).toBe(false);
  });

  it("rejects a non-owner with 403, and never triggers a real call to invocationUrl", async () => {
    let calledReal = false;
    const url = await listen((req, res) => {
      calledReal = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const ownerToken = await login(owner);
    const agentId = await createAgent(ownerToken, { invocationUrl: url });

    const strangerToken = await login(stranger);
    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/invocation-test`,
      cookies: { session_token: strangerToken },
      payload: { payload: {} },
    });
    expect(response.statusCode).toBe(403);
    expect(calledReal).toBe(false);
  });

  it("404s for a nonexistent agentId", async () => {
    const token = await login(owner);
    const response = await app.inject({
      method: "POST",
      url: `/agents/00000000-0000-0000-0000-000000000000/invocation-test`,
      cookies: { session_token: token },
      payload: { payload: {} },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/agents/00000000-0000-0000-0000-000000000000/invocation-test`,
      payload: { payload: {} },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns a clean credential_unresolved result when the Agent has no credentialRef configured", async () => {
    const token = await login(owner);
    // Deliberately `example.com`, not `example.invalid`: `callAgent`'s own
    // `assertSafeInvocationDestination` does a REAL DNS lookup for its
    // SSRF guard, checked BEFORE credential resolution — and RFC 2606
    // reserves `.invalid` to NEVER resolve, so a standards-compliant
    // resolver (confirmed: GitHub Actions' CI runner) makes that lookup
    // fail and short-circuits to `network_error` before this test's own
    // target code path (credential resolution) is ever reached. A local
    // machine whose resolver happens to hijack NXDOMAIN responses (some
    // ISP/VPN configurations do) can mask this and let the test "pass"
    // for the wrong reason. `example.com` is IANA's own reserved-and-
    // guaranteed-resolvable documentation domain — real, stable public
    // IPs everywhere — so the SSRF check deterministically passes and
    // this test actually reaches the credential check it's named for.
    const agentId = await createAgent(token, { invocationUrl: "https://example.com" });

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/invocation-test`,
      cookies: { session_token: token },
      payload: { payload: {} },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("credential_unresolved");
  });
});
