import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { advanceDag } from "./service.js";

/**
 * Real-Postgres integration test for T-1706's `POST
 * /dags/:dagId/nodes/:nodeId/select-result` — AC-1704's own core assertion:
 * choosing one parallel node's result as the AGGREGATE node's basis must
 * NOT change the other (unselected) parallel node's own real task/
 * settlement in any way. Same harness pattern as
 * `advance.integration.test.ts`/`node-control.integration.test.ts`.
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
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

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

runIfOptedIn("POST /dags/:dagId/nodes/:nodeId/select-result (integration, T-1706)", () => {
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

  async function nodeRowsByTitle(
    dagId: string,
  ): Promise<Map<string, { id: string; node_status: string; task_id: string | null }>> {
    const { rows } = await pool.query<{
      id: string;
      title: string;
      node_status: string;
      task_id: string | null;
    }>(`SELECT id, title, node_status, task_id FROM task_dag_nodes WHERE dag_id = $1`, [dagId]);
    return new Map(
      rows.map((row) => [
        row.title,
        { id: row.id, node_status: row.node_status, task_id: row.task_id },
      ]),
    );
  }

  async function setupAggregateScenario(
    cookie: string,
  ): Promise<{ dagId: string; nodeA: string; nodeB: string; aggregateId: string }> {
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "AC-1704 select-result scenario",
        category: "writing",
        totalBudget: "300",
        nodes: [
          baseNode({ key: "a", title: "Parallel A", role: "PARALLEL" }),
          baseNode({ key: "b", title: "Parallel B", role: "PARALLEL" }),
          baseNode({ key: "c", title: "Aggregate C", role: "AGGREGATE", dependsOn: ["a", "b"] }),
        ],
      },
    });
    if (createResponse.statusCode !== 201) {
      throw new Error(`create failed: ${createResponse.statusCode} ${createResponse.body}`);
    }
    const dagId = createResponse.json().id as string;
    const activateResponse = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    if (activateResponse.statusCode !== 200) {
      throw new Error(`activate failed: ${activateResponse.statusCode} ${activateResponse.body}`);
    }

    const before = await nodeRowsByTitle(dagId);
    const nodeA = before.get("Parallel A");
    const nodeB = before.get("Parallel B");
    const aggregate = before.get("Aggregate C");
    if (!nodeA?.task_id || !nodeB?.task_id || !aggregate) {
      throw new Error("scenario setup failed");
    }

    // Both parallel nodes deliver and are RELEASED (real, distinct
    // settlement outcomes) — a real precondition for AGGREGATE readiness
    // (T-1703's own AC-1702 rule), and the state AC-1704's assertion is
    // actually about: BOTH have already, independently, correctly
    // reached a final, successful settlement before any selection happens.
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [nodeA.task_id]);
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [nodeB.task_id]);
    const advanceResult = await advanceDag(pool, dagId);
    expect(advanceResult.ok).toBe(true);

    return { dagId, nodeA: nodeA.id, nodeB: nodeB.id, aggregateId: aggregate.id };
  }

  it("AC-1704: selecting one parallel node's result does not change the OTHER (unselected) node's own real task status", async () => {
    const cookie = await login(account);
    const { dagId, nodeA, aggregateId } = await setupAggregateScenario(cookie);

    const beforeSelection = await nodeRowsByTitle(dagId);
    const nodeBTaskStatusBefore = (
      await pool.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [
        beforeSelection.get("Parallel B")?.task_id,
      ])
    ).rows[0]?.status;
    expect(nodeBTaskStatusBefore).toBe("RELEASED");

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/nodes/${aggregateId}/select-result`,
      headers: { cookie },
      payload: { selectedNodeIds: [nodeA] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().selectedNodeIds).toEqual([nodeA]);

    const { rows: persistedRows } = await pool.query<{ selected_predecessor_ids: string[] }>(
      `SELECT selected_predecessor_ids FROM task_dag_nodes WHERE id = $1`,
      [aggregateId],
    );
    expect(persistedRows[0]?.selected_predecessor_ids).toEqual([nodeA]);

    // AC-1704's core assertion: node B's own real task is COMPLETELY
    // untouched by A being selected — still RELEASED, not refunded, not
    // reset, not marked as any kind of "not chosen" failure.
    const { rows: nodeBRows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [beforeSelection.get("Parallel B")?.task_id],
    );
    expect(nodeBRows[0]?.status).toBe("RELEASED");

    // Node B's own node_status is also untouched — DONE (from the earlier
    // advanceDag sync), not reverted or altered by the selection.
    const after = await nodeRowsByTitle(dagId);
    expect(after.get("Parallel B")?.node_status).toBe("DONE");
    expect(after.get("Parallel A")?.node_status).toBe("DONE");
  });

  it("allows selecting BOTH predecessors (聚合, not just 择优)", async () => {
    const cookie = await login(account);
    const { dagId, nodeA, nodeB, aggregateId } = await setupAggregateScenario(cookie);

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/nodes/${aggregateId}/select-result`,
      headers: { cookie },
      payload: { selectedNodeIds: [nodeA, nodeB] },
    });
    expect(response.statusCode).toBe(200);
    expect(new Set(response.json().selectedNodeIds as string[])).toEqual(new Set([nodeA, nodeB]));
  });

  it("rejects selecting a node that is not a direct predecessor with 409", async () => {
    const cookie = await login(account);
    const { dagId, aggregateId } = await setupAggregateScenario(cookie);

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/nodes/${aggregateId}/select-result`,
      headers: { cookie },
      payload: { selectedNodeIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects selecting a predecessor that has not reached DONE yet", async () => {
    const cookie = await login(account);
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Not yet done",
        category: "writing",
        totalBudget: "300",
        nodes: [
          baseNode({ key: "a", title: "Parallel A", role: "PARALLEL" }),
          baseNode({ key: "b", title: "Parallel B", role: "PARALLEL" }),
          baseNode({ key: "c", title: "Aggregate C", role: "AGGREGATE", dependsOn: ["a", "b"] }),
        ],
      },
    });
    const dagId = createResponse.json().id as string;
    await app.inject({ method: "POST", url: `/dags/${dagId}/activate`, headers: { cookie } });
    const nodes = await nodeRowsByTitle(dagId);
    const nodeA = nodes.get("Parallel A");
    const aggregate = nodes.get("Aggregate C");
    if (!nodeA || !aggregate) throw new Error("scenario setup failed");
    expect(nodeA.node_status).toBe("TASK_ACTIVE");

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/nodes/${aggregate.id}/select-result`,
      headers: { cookie },
      payload: { selectedNodeIds: [nodeA.id] },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects a non-AGGREGATE node with 409", async () => {
    const cookie = await login(account);
    const { dagId, nodeA } = await setupAggregateScenario(cookie);

    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/nodes/${nodeA}/select-result`,
      headers: { cookie },
      payload: { selectedNodeIds: [nodeA] },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects a non-requester with 403", async () => {
    const cookie = await login(account);
    const { dagId, nodeA, aggregateId } = await setupAggregateScenario(cookie);

    const otherCookie = await login(otherAccount);
    const response = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/nodes/${aggregateId}/select-result`,
      headers: { cookie: otherCookie },
      payload: { selectedNodeIds: [nodeA] },
    });
    expect(response.statusCode).toBe(403);

    const { rows } = await pool.query<{ selected_predecessor_ids: string[] }>(
      `SELECT selected_predecessor_ids FROM task_dag_nodes WHERE id = $1`,
      [aggregateId],
    );
    expect(rows[0]?.selected_predecessor_ids).toEqual([]);
  });
});
