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
// TEST_DATABASE_URL. Proves T-502's AC-501 (create Agents of different
// capabilities), AC-502 (defaults: status set, completedTaskCount=0,
// qualityScore literally null — not 0 or any other number), and AC-504
// (invalid input rejected with a stable error shape) end to end through the
// real HTTP route, not just schema.ts's Zod rules in isolation.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

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

runIfOptedIn("POST /agents (integration, AC-501/AC-502/AC-504)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, schema_migrations CASCADE",
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

  async function login(): Promise<string> {
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
    expect(verifyResponse.statusCode).toBe(200);
    return extractCookieValue(verifyResponse.headers["set-cookie"], "session_token");
  }

  const VALID_PAYLOAD = {
    name: "Copy Polisher",
    description: "Polishes marketing copy for tone and clarity.",
    category: "writing",
    skillTags: ["copywriting", "editing"],
    payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    pricingType: "FREE",
  };

  it("creates an Agent bound to the session address, defaulting status/completedTaskCount/qualityScore (AC-502)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: VALID_PAYLOAD,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(typeof body.agentId).toBe("string");
    expect(["ACTIVE", "INACTIVE"]).toContain(body.status);
    expect(body.completedTaskCount).toBe(0);
    // Must be literally null, not 0 or any other number — a stray default
    // value here would silently masquerade as a real quality rating (F-506).
    expect(body.qualityScore).toBeNull();

    const { rows } = await pool.query(
      `SELECT owner_address, quality_score, completed_task_count FROM agents WHERE id = $1`,
      [body.agentId],
    );
    expect(rows[0]?.owner_address).toBe(account.address.toLowerCase());
    expect(rows[0]?.quality_score).toBeNull();
    expect(rows[0]?.completed_task_count).toBe(0);
  });

  it("creates three Agents with different categories/skill tags, all visible under the same owner (AC-501)", async () => {
    const token = await login();
    const variants = [
      { ...VALID_PAYLOAD, name: "Copy Polisher", category: "writing", skillTags: ["copywriting"] },
      {
        ...VALID_PAYLOAD,
        name: "Bug Triager",
        category: "engineering",
        skillTags: ["debugging", "triage"],
      },
      { ...VALID_PAYLOAD, name: "Data Cleaner", category: "data", skillTags: ["etl"] },
    ];

    for (const variant of variants) {
      const response = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: token },
        payload: variant,
      });
      expect(response.statusCode).toBe(201);
    }

    const { rows } = await pool.query(
      `SELECT category FROM agents WHERE owner_address = $1 ORDER BY category`,
      [account.address.toLowerCase()],
    );
    expect(rows.map((row) => row.category)).toEqual(["data", "engineering", "writing"]);
  });

  it("rejects a request with no session cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      payload: VALID_PAYLOAD,
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects missing required fields with a stable error shape (AC-504)", async () => {
    const token = await login();
    const withoutName: Record<string, unknown> = { ...VALID_PAYLOAD };
    delete withoutName.name;
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: withoutName,
    });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error.message).toBe("string");
  });

  it("rejects a malformed invocationUrl (AC-504)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, invocationUrl: "not-a-url" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-http(s) invocationUrl scheme (Codex round 1 P2, stored-XSS risk)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, invocationUrl: "javascript:alert(1)" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an overlong description (AC-504)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, description: "x".repeat(5001) },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a malformed payoutAddress (AC-504)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, payoutAddress: "not-an-address" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("stores and returns a high-precision referencePrice byte-identical, never rounded through a JS number (Codex round 3 blocking)", async () => {
    const token = await login();
    // Far beyond IEEE-754 double precision (~15-17 significant digits) —
    // if this were ever parsed through Number(), it would silently round.
    const highPrecisionPrice = "123456789012345678901234567890.123456789012345678901234567890";
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, referencePrice: highPrecisionPrice },
    });
    expect(response.statusCode).toBe(201);

    const detail = await app.inject({
      method: "GET",
      url: `/agents/${response.json().agentId}`,
    });
    expect(detail.json().referencePrice).toBe(highPrecisionPrice);

    const { rows } = await pool.query(
      `SELECT reference_price::text AS price FROM agents WHERE id = $1`,
      [response.json().agentId],
    );
    expect(rows[0]?.price).toBe(highPrecisionPrice);
  });

  it("rejects a referencePrice with scientific notation (AC-504)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, referencePrice: "1e10" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a negative referencePrice (AC-504)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, referencePrice: "-1" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-numeric referencePrice (AC-504)", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, referencePrice: "not-a-number" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("deduplicates repeated skill tags instead of failing the insert", async () => {
    const token = await login();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: { ...VALID_PAYLOAD, skillTags: ["copywriting", "copywriting"] },
    });
    expect(response.statusCode).toBe(201);

    const { rows } = await pool.query(`SELECT skill_tag FROM agent_skills WHERE agent_id = $1`, [
      response.json().agentId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
