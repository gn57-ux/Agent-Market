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
 * Real-HTTP integration test for `POST /dags` (Feature 17, T-1701).
 * Skipped unless RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
 * TEST_DATABASE_URL, same as every other `*.integration.test.ts` suite.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE";

function baseNode(overrides: Record<string, unknown> = {}) {
  return {
    key: "a",
    role: "SERIAL",
    title: "Node A title",
    description: "Node A",
    subBudget: "100",
    expertType: "AUTOMATION",
    deliveryDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    skillTags: [],
    dependsOn: [],
    ...overrides,
  };
}

runIfOptedIn("POST /dags (integration, T-1701)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const account = privateKeyToAccount(generatePrivateKey());

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
    await pool.query("DELETE FROM task_dags");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
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
    if (!match?.[1]) throw new Error("login: no session_token cookie in response");
    return `session_token=${match[1]}`;
  }

  it("rejects an unauthenticated request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      payload: { title: "T", category: "writing", totalBudget: "100", nodes: [baseNode()] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("creates a single-node DAG for the authenticated requester", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Single node",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode()],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("DRAFT");
    expect(body.category).toBe("writing");
    expect(body.requesterAddress).toBe(account.address.toLowerCase());
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].subBudget).toBe("100");
    expect(body.nodes[0].description).toBe("Node A");

    // N4 round-2 real finding: category/description were previously
    // accepted by the schema but discarded before ever reaching the
    // database — assert the real persisted rows, not just the response
    // body (which the server could have echoed back from the input
    // without actually having stored it).
    const { rows: dagRows } = await pool.query<{ category: string }>(
      `SELECT category FROM task_dags WHERE id = $1`,
      [body.id],
    );
    expect(dagRows[0]?.category).toBe("writing");
    const { rows: nodeRows } = await pool.query<{ description: string }>(
      `SELECT description FROM task_dag_nodes WHERE id = $1`,
      [body.nodes[0].id],
    );
    expect(nodeRows[0]?.description).toBe("Node A");

    const { rows } = await pool.query("SELECT count(*) FROM task_dag_edges WHERE dag_id = $1", [
      body.id,
    ]);
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("creates a serial three-node DAG with real edges (AC-1701's topology)", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Serial chain",
        category: "writing",
        totalBudget: "300",
        nodes: [
          baseNode({ key: "a" }),
          baseNode({ key: "b", dependsOn: ["a"] }),
          baseNode({ key: "c", dependsOn: ["b"] }),
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.nodes).toHaveLength(3);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM task_dag_edges WHERE dag_id = $1",
      [body.id],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it("rejects a cyclic DAG with 400 and does not persist anything", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Cyclic",
        category: "writing",
        totalBudget: "200",
        nodes: [baseNode({ key: "a", dependsOn: ["b"] }), baseNode({ key: "b", dependsOn: ["a"] })],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("TOPOLOGY_INVALID");

    const { rows } = await pool.query("SELECT count(*) FROM task_dags");
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("rejects an AGGREGATE node with no preconditions", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Bad aggregate",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", role: "AGGREGATE" })],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("TOPOLOGY_INVALID");
  });

  it("rejects a sub-budget sum that doesn't match the declared total budget", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Bad budget",
        category: "writing",
        totalBudget: "999",
        nodes: [baseNode({ key: "a", subBudget: "100" }), baseNode({ key: "b", subBudget: "100" })],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BUDGET_MISMATCH");
  });

  it("rejects a malformed request body with a 400 and a Chinese-readable message", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: { title: "", category: "writing", totalBudget: "100", nodes: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error.message).toBe("string");
  });

  it("persists each node's skill tags", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "With skills",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ skillTags: ["python", "data-viz"] })],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.nodes[0].skillTags.sort()).toEqual(["data-viz", "python"]);

    const { rows } = await pool.query<{ skill_tag: string }>(
      "SELECT skill_tag FROM task_dag_node_skills WHERE node_id = $1 ORDER BY skill_tag",
      [body.nodes[0].id],
    );
    expect(rows.map((row) => row.skill_tag)).toEqual(["data-viz", "python"]);
  });

  it("rejects a duplicate skill tag on the same node with a clean 400, not a 500 (N4 round-2 fix)", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Dup skills",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ skillTags: ["python", "python"] })],
      },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query("SELECT count(*) FROM task_dags");
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("rejects a duplicate dependsOn entry on the same node with a clean 400, not a 500 (N4 round-2 fix)", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Dup deps",
        category: "writing",
        totalBudget: "200",
        nodes: [baseNode({ key: "a" }), baseNode({ key: "b", dependsOn: ["a", "a"] })],
      },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query("SELECT count(*) FROM task_dags");
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
