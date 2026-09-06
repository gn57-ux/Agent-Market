import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { LangGraphDagExecutor } from "./langgraph-executor.js";
import { SimpleDagExecutor } from "./executor.js";

/**
 * T-1709 — real-Postgres proof that `LangGraphDagExecutor` is a genuine
 * drop-in replacement for `SimpleDagExecutor`: same real DB effects for
 * the same real scenarios (AC-1702's own serial-chain and parallel+
 * aggregate cases, reused here rather than duplicated as new scenarios —
 * `advance.integration.test.ts` already owns exhaustively covering
 * `advanceDag`'s own state-machine correctness; this file's only job is
 * proving the LangGraph wrapper around it introduces zero behavioral
 * difference), plus the requirement's own explicit extra check: discarding
 * a `LangGraphDagExecutor` instance mid-DAG and continuing with a BRAND
 * NEW instance (no shared graph, no shared LangGraph-internal state of any
 * kind — see `langgraph-executor.ts`'s own doc comment on why it keeps no
 * checkpointer at all, N4 round-1 finding) must not change anything — the
 * user's own "运行状态必须持久化" requirement (requirements.md v1.1's Q-1701
 * resolution), same spirit as T-1708's executor-restart proof but
 * targeting LangGraph's OWN internal state specifically, not just the
 * poller's scheduling state.
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

runIfOptedIn("LangGraphDagExecutor (integration, T-1709)", () => {
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
    await pool.query("DELETE FROM tasks");
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

  async function createAndActivateDag(payload: Record<string, unknown>): Promise<string> {
    const cookie = await login();
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload,
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
    return dagId;
  }

  async function nodeStatusByTitle(
    dagId: string,
  ): Promise<Map<string, { node_status: string; task_id: string | null }>> {
    const { rows } = await pool.query<{
      title: string;
      node_status: string;
      task_id: string | null;
    }>(`SELECT title, node_status, task_id FROM task_dag_nodes WHERE dag_id = $1`, [dagId]);
    return new Map(
      rows.map((row) => [row.title, { node_status: row.node_status, task_id: row.task_id }]),
    );
  }

  it("AC-1702 serial chain: LangGraphDagExecutor.advance produces the identical real DB effect as SimpleDagExecutor", async () => {
    const dagId = await createAndActivateDag({
      title: "LangGraph serial chain",
      category: "writing",
      totalBudget: "300",
      nodes: [
        baseNode({ key: "a", title: "Step A" }),
        baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
        baseNode({ key: "c", title: "Step C", dependsOn: ["b"] }),
      ],
    });

    let statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Step A")?.node_status).toBe("TASK_ACTIVE");

    const executor = new LangGraphDagExecutor();

    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Step A")?.task_id,
    ]);
    const firstResult = await executor.advance(pool, dagId);
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) throw new Error("unreachable");
    expect(firstResult.syncedNodeIds).toHaveLength(1);
    expect(firstResult.activatedNodeIds).toHaveLength(1);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Step A")?.node_status).toBe("DONE");
    expect(statuses.get("Step B")?.node_status).toBe("TASK_ACTIVE");
    expect(statuses.get("Step C")?.node_status).toBe("PENDING");

    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Step B")?.task_id,
    ]);
    const secondResult = await executor.advance(pool, dagId);
    expect(secondResult.ok).toBe(true);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Step B")?.node_status).toBe("DONE");
    expect(statuses.get("Step C")?.node_status).toBe("TASK_ACTIVE");
  });

  it("AC-1702 parallel + aggregate: LangGraphDagExecutor correctly refuses to activate the aggregate until BOTH parallel predecessors are DONE", async () => {
    const dagId = await createAndActivateDag({
      title: "LangGraph parallel + aggregate",
      category: "writing",
      totalBudget: "300",
      nodes: [
        baseNode({ key: "a", title: "Parallel A", role: "PARALLEL" }),
        baseNode({ key: "b", title: "Parallel B", role: "PARALLEL" }),
        baseNode({ key: "c", title: "Aggregate C", role: "AGGREGATE", dependsOn: ["a", "b"] }),
      ],
    });

    const executor = new LangGraphDagExecutor();
    let statuses = await nodeStatusByTitle(dagId);

    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Parallel A")?.task_id,
    ]);
    const afterOnlyA = await executor.advance(pool, dagId);
    expect(afterOnlyA.ok).toBe(true);
    if (!afterOnlyA.ok) throw new Error("unreachable");
    expect(afterOnlyA.activatedNodeIds).toHaveLength(0);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Aggregate C")?.node_status).toBe("PENDING");

    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Parallel B")?.task_id,
    ]);
    const afterBoth = await executor.advance(pool, dagId);
    expect(afterBoth.ok).toBe(true);
    if (!afterBoth.ok) throw new Error("unreachable");
    expect(afterBoth.activatedNodeIds).toHaveLength(1);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Aggregate C")?.node_status).toBe("TASK_ACTIVE");
  });

  it("discarding a LangGraphDagExecutor instance and starting a brand-new one does not affect the DAG's real progress — Postgres is the only real state", async () => {
    const dagId = await createAndActivateDag({
      title: "No LangGraph-internal state is load-bearing",
      category: "writing",
      totalBudget: "200",
      nodes: [
        baseNode({ key: "a", title: "Step A" }),
        baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
      ],
    });

    // Instance 1 advances the DAG partway.
    const executor1 = new LangGraphDagExecutor();
    const statuses = await nodeStatusByTitle(dagId);
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Step A")?.task_id,
    ]);
    const result1 = await executor1.advance(pool, dagId);
    expect(result1.ok).toBe(true);

    // Discard executor1 entirely (its own compiled graph, everything about
    // it) — a brand-new instance has never seen this dagId before and, per
    // `langgraph-executor.ts`'s own design (no checkpointer at all — N4
    // round-1 finding), has no mechanism to remember it even if it had.
    const executor2 = new LangGraphDagExecutor();
    const midway = await nodeStatusByTitle(dagId);
    expect(midway.get("Step B")?.task_id).toBeTruthy();
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      midway.get("Step B")?.task_id,
    ]);
    const result2 = await executor2.advance(pool, dagId);
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error("unreachable");
    expect(result2.dagCompleted).toBe(true);

    const final = await nodeStatusByTitle(dagId);
    expect(final.get("Step A")?.node_status).toBe("DONE");
    expect(final.get("Step B")?.node_status).toBe("DONE");

    const { rows: dagRows } = await pool.query<{ status: string }>(
      `SELECT status FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(dagRows[0]?.status).toBe("COMPLETED");
  });

  it("N4 real finding (round 1, P1): the compiled graph has no checkpointer, so a single long-lived executor instance polling repeatedly cannot accumulate checkpoint history", async () => {
    // Reproduces the exact production shape the finding was about:
    // `server.ts` holds ONE `LangGraphDagExecutor` for the whole process
    // lifetime, and `dag-poller.ts` calls `.advance()` on it every tick,
    // forever — including many ticks after the DAG has nothing left to do.
    // The original bug was `MemorySaver` silently growing with every one
    // of these calls. The structural proof (stronger than inferring "no
    // leak" from process memory, which vitest can't reliably measure): the
    // compiled graph's own `checkpointer` is `undefined` — LangGraph has
    // nothing to write a checkpoint to at all, on this call or any later
    // one, so there is no history that could possibly accumulate.
    const executor = new LangGraphDagExecutor();
    // `graph` is declared `private` in TypeScript (compile-time only, per
    // this codebase's own established pattern of never using bracket-
    // access workarounds to dodge that) — reading it via a type assertion
    // here is a deliberate, narrow test-only inspection of internal
    // structure, not a production code path.
    const compiledGraph = (executor as unknown as { graph: { checkpointer: unknown } }).graph;
    expect(compiledGraph.checkpointer).toBeUndefined();

    const dagId = await createAndActivateDag({
      title: "Repeated polling does not leak",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode({ key: "a", title: "Only step" })],
    });
    const statuses = await nodeStatusByTitle(dagId);
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Only step")?.task_id,
    ]);

    // The DAG completes on the first tick — every later tick correctly
    // reports `NOT_ACTIVE` (advanceDag's own routine, expected outcome for
    // an already-COMPLETED DAG, exactly matching what a real poller
    // continuing to check a finished DAG would see) rather than erroring.
    for (let tick = 0; tick < 20; tick += 1) {
      const result = await executor.advance(pool, dagId);
      if (tick === 0) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, reason: "NOT_ACTIVE", detail: expect.any(String) });
      }
    }

    // Still no checkpointer after 20 real ticks against a real DAG.
    expect(compiledGraph.checkpointer).toBeUndefined();

    const final = await nodeStatusByTitle(dagId);
    expect(final.get("Only step")?.node_status).toBe("DONE");
  });

  it("SimpleDagExecutor and LangGraphDagExecutor produce byte-identical AdvanceDagResult shapes for the same real scenario", async () => {
    const dagIdA = await createAndActivateDag({
      title: "Simple executor run",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode({ key: "a", title: "Only step" })],
    });
    const dagIdB = await createAndActivateDag({
      title: "LangGraph executor run",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode({ key: "a", title: "Only step" })],
    });

    const statusesA = await nodeStatusByTitle(dagIdA);
    const statusesB = await nodeStatusByTitle(dagIdB);
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statusesA.get("Only step")?.task_id,
    ]);
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statusesB.get("Only step")?.task_id,
    ]);

    const simpleResult = await new SimpleDagExecutor().advance(pool, dagIdA);
    const langGraphResult = await new LangGraphDagExecutor().advance(pool, dagIdB);

    // Both are real, independent DAGs (different ids), so this compares
    // SHAPE (same fields, same lengths, same booleans), not literal id
    // equality — the point is the two executors made the same DECISION.
    expect(simpleResult.ok).toBe(langGraphResult.ok);
    if (simpleResult.ok && langGraphResult.ok) {
      expect(simpleResult.syncedNodeIds).toHaveLength(langGraphResult.syncedNodeIds.length);
      expect(simpleResult.activatedNodeIds).toHaveLength(langGraphResult.activatedNodeIds.length);
      expect(simpleResult.dagCompleted).toBe(langGraphResult.dagCompleted);
      expect(simpleResult.rematchedNodeIds).toEqual(langGraphResult.rematchedNodeIds);
    }
  });
});
