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
// TEST_DATABASE_URL. Proves T-503's F-502 behavior (pagination, filtering,
// detail lookup) end to end against a real database.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn("GET /agents, GET /agents/:agentId (integration, F-502)", () => {
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
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE",
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
    const setCookie = verifyResponse.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = /session_token=([^;]+)/.exec(String(header));
    if (!match?.[1]) throw new Error("no session_token cookie in verify response");
    return match[1];
  }

  async function createAgent(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: {
        name: "Test Agent",
        description: "desc",
        category: "writing",
        skillTags: ["copywriting"],
        payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
        pricingType: "FREE",
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().agentId;
  }

  it("lists Agents with a default page size of 20 and correct total", async () => {
    const token = await login();
    for (let i = 0; i < 3; i += 1) {
      await createAgent(token, { name: `Agent ${i}` });
    }

    const response = await app.inject({ method: "GET", url: "/agents" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.items).toHaveLength(3);
  });

  it("paginates correctly across pages", async () => {
    const token = await login();
    for (let i = 0; i < 5; i += 1) {
      await createAgent(token, { name: `Agent ${i}` });
    }

    const page1 = await app.inject({ method: "GET", url: "/agents?page=1&pageSize=2" });
    const page2 = await app.inject({ method: "GET", url: "/agents?page=2&pageSize=2" });
    const page3 = await app.inject({ method: "GET", url: "/agents?page=3&pageSize=2" });

    expect(page1.json().items).toHaveLength(2);
    expect(page2.json().items).toHaveLength(2);
    expect(page3.json().items).toHaveLength(1);
    expect(page1.json().total).toBe(5);
    expect(page3.json().total).toBe(5);

    const allIds = [
      ...page1.json().items.map((a: { agentId: string }) => a.agentId),
      ...page2.json().items.map((a: { agentId: string }) => a.agentId),
      ...page3.json().items.map((a: { agentId: string }) => a.agentId),
    ];
    expect(new Set(allIds).size).toBe(5);
  });

  it("reports the true total even when the requested page is beyond the last populated page (Codex round 1 P2)", async () => {
    const token = await login();
    for (let i = 0; i < 3; i += 1) {
      await createAgent(token, { name: `Agent ${i}` });
    }

    const response = await app.inject({ method: "GET", url: "/agents?page=99&pageSize=2" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(3);
  });

  it("rejects a pageSize above the 20-item ceiling", async () => {
    const response = await app.inject({ method: "GET", url: "/agents?pageSize=21" });
    expect(response.statusCode).toBe(400);
  });

  it("filters by category", async () => {
    const token = await login();
    await createAgent(token, { name: "Writer", category: "writing" });
    await createAgent(token, { name: "Coder", category: "engineering" });

    const response = await app.inject({ method: "GET", url: "/agents?category=engineering" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].name).toBe("Coder");
  });

  it("filters by skillTag without truncating the matched agent's own tag list", async () => {
    const token = await login();
    await createAgent(token, {
      name: "Multi-skill",
      skillTags: ["copywriting", "editing", "seo"],
    });
    await createAgent(token, { name: "Other", skillTags: ["debugging"] });

    const response = await app.inject({ method: "GET", url: "/agents?skillTag=editing" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].name).toBe("Multi-skill");
    expect(body.items[0].skillTags.sort()).toEqual(["copywriting", "editing", "seo"]);
  });

  it("returns an INACTIVE agent's status as-is rather than filtering it out implicitly (AC-505 groundwork)", async () => {
    const token = await login();
    const agentId = await createAgent(token, { name: "Will Deactivate" });
    await pool.query(`UPDATE agents SET status = 'INACTIVE' WHERE id = $1`, [agentId]);

    const response = await app.inject({ method: "GET", url: "/agents" });
    const body = response.json();
    const found = body.items.find((a: { agentId: string }) => a.agentId === agentId);
    expect(found?.status).toBe("INACTIVE");
  });

  it("returns Agent detail including completedTaskCount/successCount/overdueCount/qualityScore", async () => {
    const token = await login();
    const agentId = await createAgent(token);

    const response = await app.inject({ method: "GET", url: `/agents/${agentId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.agentId).toBe(agentId);
    expect(body.completedTaskCount).toBe(0);
    expect(body.successCount).toBe(0);
    expect(body.overdueCount).toBe(0);
    expect(body.qualityScore).toBeNull();
    // T-505 needs this to pre-fill the edit form with the current payout
    // address — regression for a response shape that originally omitted it.
    expect(body.payoutAddress).toBe("0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3");
  });

  it("returns 404 for a well-formed but nonexistent agentId", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/agents/00000000-0000-0000-0000-000000000000",
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a malformed agentId (not a UUID)", async () => {
    const response = await app.inject({ method: "GET", url: "/agents/not-a-uuid" });
    expect(response.statusCode).toBe(400);
  });
});
