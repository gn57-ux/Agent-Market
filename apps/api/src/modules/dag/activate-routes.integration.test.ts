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
 * Real-HTTP integration test for `POST /dags/:dagId/activate` (Feature 17,
 * T-1702). Covers everything about activation that doesn't require a real
 * chain (readiness computation, ownership, DAG-status guard, real `tasks`
 * row creation/linkage) — the real-on-chain proof that a newly-created
 * task genuinely integrates with the EXISTING funding-verification flow is
 * `activate.hardhat.e2e.test.ts`'s job, not this file's (this file would
 * have to fake or skip that half of the story either way; keeping the
 * DB-only assertions here fast and the chain assertions there focused
 * matches how `office/routes.integration.test.ts`'s own funds-zone test
 * was split out from its main suite in Feature 15).
 *
 * Skipped unless RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
 * TEST_DATABASE_URL, same as every other `*.integration.test.ts` suite.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

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

runIfOptedIn("POST /dags/:dagId/activate (integration, T-1702)", () => {
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
    // task_dag_nodes.task_id -> tasks(id) has no ON DELETE CASCADE
    // (0021_create_task_dags.sql), so task_dags must be cleared FIRST
    // (cascading away the nodes that reference a task) before tasks itself
    // can be deleted without hitting that FK.
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

  async function createDag(cookie: string, payload: Record<string, unknown>): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload,
    });
    if (response.statusCode !== 201) {
      throw new Error(`createDag: expected 201, got ${response.statusCode}: ${response.body}`);
    }
    return response.json().id as string;
  }

  it("rejects an unauthenticated request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/dags/00000000-0000-0000-0000-000000000000/activate",
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects activation of a DAG that doesn't exist with 404", async () => {
    const cookie = await login(account);
    const response = await app.inject({
      method: "POST",
      url: "/dags/00000000-0000-0000-0000-000000000000/activate",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects activation by a wallet that isn't the DAG's requester with 403, and does not mutate anything", async () => {
    const ownerCookie = await login(account);
    const dagId = await createDag(ownerCookie, {
      title: "T",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode()],
    });

    const otherCookie = await login(otherAccount);
    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(403);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(rows[0]?.status).toBe("DRAFT");
  });

  it("activates a single ready node: creates a real DRAFT tasks row, links task_id, advances node_status, marks the DAG ACTIVE", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Single node",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode({ title: "Real task title" })],
    });

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.activatedNodeIds).toHaveLength(1);

    const { rows: dagRows } = await pool.query<{ status: string }>(
      `SELECT status FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(dagRows[0]?.status).toBe("ACTIVE");

    const { rows: nodeRows } = await pool.query<{ task_id: string; node_status: string }>(
      `SELECT task_id, node_status FROM task_dag_nodes WHERE id = $1`,
      [body.activatedNodeIds[0]],
    );
    expect(nodeRows[0]?.node_status).toBe("TASK_ACTIVE");
    expect(nodeRows[0]?.task_id).toBeTruthy();

    const { rows: taskRows } = await pool.query<{
      status: string;
      title: string;
      requester_address: string;
      category: string;
    }>(`SELECT status, title, requester_address, category FROM tasks WHERE id = $1`, [
      nodeRows[0]?.task_id,
    ]);
    expect(taskRows[0]?.status).toBe("DRAFT");
    expect(taskRows[0]?.title).toBe("Real task title");
    expect(taskRows[0]?.requester_address).toBe(account.address.toLowerCase());
    expect(taskRows[0]?.category).toBe("writing");
  });

  it("AC-1701's serial three-node scenario: activating creates a real task for only the first node; the other two stay PENDING with no task_id", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Serial chain",
      category: "writing",
      totalBudget: "300",
      nodes: [
        baseNode({ key: "a", title: "Step A" }),
        baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
        baseNode({ key: "c", title: "Step C", dependsOn: ["b"] }),
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().activatedNodeIds).toHaveLength(1);

    const { rows } = await pool.query<{
      title: string;
      node_status: string;
      task_id: string | null;
    }>(`SELECT title, node_status, task_id FROM task_dag_nodes WHERE dag_id = $1 ORDER BY title`, [
      dagId,
    ]);
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    expect(byTitle.get("Step A")?.node_status).toBe("TASK_ACTIVE");
    expect(byTitle.get("Step A")?.task_id).toBeTruthy();
    expect(byTitle.get("Step B")?.node_status).toBe("PENDING");
    expect(byTitle.get("Step B")?.task_id).toBeNull();
    expect(byTitle.get("Step C")?.node_status).toBe("PENDING");
    expect(byTitle.get("Step C")?.task_id).toBeNull();
  });

  it("AC-1702's parallel+aggregate scenario: both parallel nodes activate, the aggregate node (which has preconditions) stays PENDING", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Parallel + aggregate",
      category: "writing",
      totalBudget: "300",
      nodes: [
        baseNode({ key: "a", title: "Parallel A", role: "PARALLEL" }),
        baseNode({ key: "b", title: "Parallel B", role: "PARALLEL" }),
        baseNode({ key: "c", title: "Aggregate C", role: "AGGREGATE", dependsOn: ["a", "b"] }),
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().activatedNodeIds).toHaveLength(2);

    const { rows } = await pool.query<{ title: string; node_status: string }>(
      `SELECT title, node_status FROM task_dag_nodes WHERE dag_id = $1 ORDER BY title`,
      [dagId],
    );
    const byTitle = new Map(rows.map((row) => [row.title, row.node_status]));
    expect(byTitle.get("Parallel A")).toBe("TASK_ACTIVE");
    expect(byTitle.get("Parallel B")).toBe("TASK_ACTIVE");
    expect(byTitle.get("Aggregate C")).toBe("PENDING");
  });

  it("rejects activating a DAG a second time (already ACTIVE) with 409, and does not create duplicate tasks", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Double activate",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode()],
    });

    const first = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("NOT_DRAFT");

    const { rows } = await pool.query(`SELECT count(*) FROM tasks WHERE requester_address = $1`, [
      account.address.toLowerCase(),
    ]);
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("N4 real finding (concurrency): two simultaneous activation requests for the same DAG create exactly one task, not two — the loser sees a clean 409, not a silently-overwritten task_id", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Concurrent activate",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode()],
    });

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/dags/${dagId}/activate`, headers: { cookie } }),
      app.inject({ method: "POST", url: `/dags/${dagId}/activate`, headers: { cookie } }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const { rows: taskRows } = await pool.query(
      `SELECT count(*) FROM tasks WHERE requester_address = $1`,
      [account.address.toLowerCase()],
    );
    expect(Number(taskRows[0]?.count)).toBe(1);

    // The one real task must be reachable from exactly one node — no
    // orphan task, no node whose task_id was silently clobbered by the
    // losing request.
    const { rows: nodeRows } = await pool.query<{ task_id: string | null }>(
      `SELECT task_id FROM task_dag_nodes WHERE dag_id = $1`,
      [dagId],
    );
    expect(nodeRows).toHaveLength(1);
    expect(nodeRows[0]?.task_id).toBeTruthy();
  });

  it("N4 real finding (deadline): activating a node whose delivery_deadline has already passed by activation time is rejected with 409, and creates no task", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Expired deadline",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode()],
    });

    // Simulates real time passing between DAG creation (deadline was
    // genuinely in the future then, per schema.ts's own future-deadline
    // check) and a much-later activation call — not a schema bypass.
    await pool.query(
      `UPDATE task_dag_nodes SET delivery_deadline = now() - interval '1 day' WHERE dag_id = $1`,
      [dagId],
    );

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NODE_DEADLINE_EXPIRED");

    const { rows: dagRows } = await pool.query<{ status: string }>(
      `SELECT status FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(dagRows[0]?.status).toBe("DRAFT");

    const { rows: nodeRows } = await pool.query<{ task_id: string | null; node_status: string }>(
      `SELECT task_id, node_status FROM task_dag_nodes WHERE dag_id = $1`,
      [dagId],
    );
    expect(nodeRows[0]?.task_id).toBeNull();
    expect(nodeRows[0]?.node_status).toBe("PENDING");

    const { rows: taskRows } = await pool.query(
      `SELECT count(*) FROM tasks WHERE requester_address = $1`,
      [account.address.toLowerCase()],
    );
    expect(Number(taskRows[0]?.count)).toBe(0);
  });

  it("N4 real finding (round 2): activating a node with no title/delivery_deadline (simulating a pre-0024 legacy node) is rejected with 409, not silently activated with placeholder data", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Legacy node",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode()],
    });

    // Simulates a node inserted before 0024 existed — direct SQL, not via
    // the app (POST /dags always supplies both, per createDagSchema).
    await pool.query(
      `UPDATE task_dag_nodes SET title = NULL, delivery_deadline = NULL WHERE dag_id = $1`,
      [dagId],
    );

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NODE_MISSING_ACTIVATION_FIELDS");

    const { rows: dagRows } = await pool.query<{ status: string }>(
      `SELECT status FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(dagRows[0]?.status).toBe("DRAFT");

    const { rows: taskRows } = await pool.query(
      `SELECT count(*) FROM tasks WHERE requester_address = $1`,
      [account.address.toLowerCase()],
    );
    expect(Number(taskRows[0]?.count)).toBe(0);
  });

  it("N4 real finding (round 2, T-1704): activating a node with no description (simulating a pre-0025 legacy node) is rejected with 409, not silently activated with an empty description", async () => {
    const cookie = await login(account);
    const dagId = await createDag(cookie, {
      title: "Legacy node, no description",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode()],
    });

    // Simulates a node inserted before 0023 required description, whose
    // value was later NULLed by 0025's own forward migration (rather than
    // left as the old '' placeholder — see that migration's own header
    // comment) — direct SQL, not via the app (POST /dags always supplies
    // a real description, per createDagSchema).
    await pool.query(`UPDATE task_dag_nodes SET description = NULL WHERE dag_id = $1`, [dagId]);

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NODE_MISSING_ACTIVATION_FIELDS");

    const { rows: taskRows } = await pool.query(
      `SELECT count(*) FROM tasks WHERE requester_address = $1`,
      [account.address.toLowerCase()],
    );
    expect(Number(taskRows[0]?.count)).toBe(0);
  });
});
