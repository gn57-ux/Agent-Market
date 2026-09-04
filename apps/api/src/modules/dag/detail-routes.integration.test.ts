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
 * Real-Postgres integration test for T-1707's `GET /dags/:dagId` — auth
 * (requester-only in this file; admin access is a plain `isAdminAddress`
 * lookup already covered by admin/repository.integration.test.ts, not
 * re-tested here) and the budget projection reflecting real
 * `task_dag_nodes`/`tasks` state. Same harness pattern as every other DAG
 * integration suite.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE";

function baseNode(overrides: Record<string, unknown> = {}) {
  return {
    key: "a",
    role: "SERIAL",
    title: "Node title",
    description: "Node description",
    subBudget: "100",
    expertType: "AUTOMATION",
    deliveryDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    skillTags: [],
    dependsOn: [],
    ...overrides,
  };
}

runIfOptedIn("GET /dags/:dagId (integration, T-1707)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const account = privateKeyToAccount(generatePrivateKey());
  const otherAccount = privateKeyToAccount(generatePrivateKey());

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
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
  });

  async function login(signer: typeof account): Promise<string> {
    const nonceResponse = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address: signer.address },
    });
    const { nonce, issuedAt, expiresAt } = nonceResponse.json();
    const message = buildSignInMessage({
      domain: "localhost",
      address: signer.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await signer.signMessage({ message });
    const verifyResponse = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: signer.address, signature, nonce },
    });
    const setCookie = verifyResponse.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = /session_token=([^;]+)/.exec(String(header));
    if (!match?.[1]) throw new Error("login: no session_token cookie in response");
    return `session_token=${match[1]}`;
  }

  it("returns 401 without a session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/dags/00000000-0000-0000-0000-000000000000",
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for a nonexistent DAG", async () => {
    const cookie = await login(account);
    const response = await app.inject({
      method: "GET",
      url: "/dags/00000000-0000-0000-0000-000000000000",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 403 for a non-requester, non-admin session", async () => {
    const cookie = await login(account);
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Private DAG",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode()],
      },
    });
    const dagId = createResponse.json().id as string;

    const otherCookie = await login(otherAccount);
    const response = await app.inject({
      method: "GET",
      url: `/dags/${dagId}`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns the DAG structure, node states, and a conserved budget projection for the requester", async () => {
    const cookie = await login(account);
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Detail view scenario",
        category: "writing",
        totalBudget: "300",
        nodes: [
          baseNode({ key: "a", title: "Step A" }),
          baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
          baseNode({ key: "c", title: "Step C", dependsOn: ["a"] }),
        ],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const dagId = createResponse.json().id as string;

    // Before activation: nothing has a task_id, so the entire declared
    // budget is notYetFunded.
    const beforeActivate = await app.inject({
      method: "GET",
      url: `/dags/${dagId}`,
      headers: { cookie },
    });
    expect(beforeActivate.statusCode).toBe(200);
    const beforeBody = beforeActivate.json();
    expect(beforeBody.status).toBe("DRAFT");
    expect(beforeBody.nodes).toHaveLength(3);
    expect(beforeBody.edges).toHaveLength(2);
    expect(beforeBody.budget).toEqual({
      totalBudget: "300",
      releasedBudget: "0",
      refundedBudget: "0",
      activeLockedBudget: "0",
      notYetFundedBudget: "300",
    });

    await app.inject({ method: "POST", url: `/dags/${dagId}/activate`, headers: { cookie } });

    const { rows: nodeRows } = await pool.query<{ title: string; task_id: string }>(
      `SELECT title, task_id FROM task_dag_nodes WHERE dag_id = $1`,
      [dagId],
    );
    const stepATaskId = nodeRows.find((row) => row.title === "Step A")?.task_id;
    if (!stepATaskId) throw new Error("Step A has no task");

    // Step A moves through OPEN (activeLocked) then RELEASED (released);
    // B/C remain notYetFunded (still PENDING, no task_id).
    await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [stepATaskId]);
    const afterOpen = await app.inject({
      method: "GET",
      url: `/dags/${dagId}`,
      headers: { cookie },
    });
    expect(afterOpen.json().budget).toEqual({
      totalBudget: "300",
      releasedBudget: "0",
      refundedBudget: "0",
      activeLockedBudget: "100",
      notYetFundedBudget: "200",
    });

    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [stepATaskId]);
    const afterReleased = await app.inject({
      method: "GET",
      url: `/dags/${dagId}`,
      headers: { cookie },
    });
    const releasedBudget = afterReleased.json();
    expect(releasedBudget.status).toBe("ACTIVE");
    expect(releasedBudget.budget).toEqual({
      totalBudget: "300",
      releasedBudget: "100",
      refundedBudget: "0",
      activeLockedBudget: "0",
      notYetFundedBudget: "200",
    });

    const nodeById = new Map(
      (releasedBudget.nodes as Array<{ id: string; title: string }>).map((node) => [
        node.title,
        node,
      ]),
    );
    expect(nodeById.get("Step A")).toMatchObject({
      nodeStatus: "TASK_ACTIVE",
      taskStatus: "RELEASED",
    });
    expect(nodeById.get("Step B")).toMatchObject({
      nodeStatus: "PENDING",
      taskId: null,
      taskStatus: null,
    });
  });

  it("N4 real finding (P1): if the requester edits the linked task's budget via PATCH .../draft before funding, the projection reports the EDITED amount, not the node's stale subBudget", async () => {
    const cookie = await login(account);
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Edited-budget scenario",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step", subBudget: "100" })],
      },
    });
    const dagId = createResponse.json().id as string;
    await app.inject({ method: "POST", url: `/dags/${dagId}/activate`, headers: { cookie } });

    const { rows: nodeRows } = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM task_dag_nodes WHERE dag_id = $1`,
      [dagId],
    );
    const taskId = nodeRows[0]?.task_id;
    if (!taskId) throw new Error("node has no task");

    // The real, pre-existing, unmodified Feature 6 endpoint — nothing
    // marks a DAG-activated task as budget-immutable.
    const editResponse = await app.inject({
      method: "PATCH",
      url: `/tasks/${taskId}/draft`,
      headers: { cookie },
      payload: { budget: "150" },
    });
    expect(editResponse.statusCode).toBe(200);

    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [taskId]);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/dags/${dagId}`,
      headers: { cookie },
    });
    expect(detailResponse.statusCode).toBe(200);
    const body = detailResponse.json();

    // The node's own declared value is untouched (immutable, per design) —
    // but the projection's actual bucketing must reflect the real, edited
    // amount the requester would go on to fund/settle on-chain.
    expect(body.nodes[0].subBudget).toBe("100");
    expect(body.nodes[0].taskBudget).toBe("150");
    expect(body.budget).toEqual({
      totalBudget: "150",
      releasedBudget: "150",
      refundedBudget: "0",
      activeLockedBudget: "0",
      notYetFundedBudget: "0",
    });
  });
});
