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
 * Real-Postgres integration test for T-1705's three node-control routes
 * (`retry`/`manual-takeover`/`cancel`'s auth+ownership layer — `cancel`'s
 * own real-chain verification is covered separately by
 * `tasks/cancel-verifications.hardhat.e2e.test.ts`, which this suite does
 * not re-prove; here `cancel` is only exercised down to the point where it
 * would call the chain, per this project's own precedent for not
 * duplicating already-covered mechanics).
 *
 * Directly manipulates `tasks.status`/`task_dag_nodes.node_status` via SQL
 * to simulate a node reaching FAILED, matching `advance.integration.test.ts`'s
 * own established approach for this module.
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
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

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

runIfOptedIn("DAG node-control routes (integration, T-1705)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const account = privateKeyToAccount(generatePrivateKey());
  const otherAccount = privateKeyToAccount(generatePrivateKey());
  const previousBackendRpcUrl = process.env.BACKEND_RPC_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
    // `POST .../cancel` constructs a `ChainRpcClient` (config only, no
    // network I/O until a method is actually called — see rpc.client.ts's
    // own doc comment) before `cancelDagNode` even reaches its own
    // DAG/node existence checks, same as every other chain-verification
    // route in this codebase (e.g. `funding-verifications`). Every `cancel`
    // scenario this file exercises returns before `verifyCancellation`
    // would ever dial this URL, so a placeholder is sufficient — real
    // chain verification is proven separately by
    // `tasks/cancel-verifications.hardhat.e2e.test.ts`.
    process.env.BACKEND_RPC_URL = "http://127.0.0.1:1";
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
    if (previousBackendRpcUrl === undefined) delete process.env.BACKEND_RPC_URL;
    else process.env.BACKEND_RPC_URL = previousBackendRpcUrl;
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

  async function createAndActivateDag(
    cookie: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
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

  describe("POST /dags/:dagId/nodes/:nodeId/manual-takeover", () => {
    it("pauses a TASK_ACTIVE node — real 200, node_status becomes MANUAL_TAKEOVER", async () => {
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Manual takeover",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node) throw new Error("node not found");
      expect(node.node_status).toBe("TASK_ACTIVE");

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/manual-takeover`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("MANUAL_TAKEOVER");

      const after = await nodeRowsByTitle(dagId);
      expect(after.get("Only step")?.node_status).toBe("MANUAL_TAKEOVER");
    });

    it("rejects a non-requester with 403 and leaves the node untouched", async () => {
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Forbidden takeover",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node) throw new Error("node not found");

      const otherCookie = await login(otherAccount);
      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/manual-takeover`,
        headers: { cookie: otherCookie },
      });
      expect(response.statusCode).toBe(403);

      const after = await nodeRowsByTitle(dagId);
      expect(after.get("Only step")?.node_status).toBe("TASK_ACTIVE");
    });

    it("refuses to pause an already-DONE node with 409", async () => {
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Cannot pause a done node",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node) throw new Error("node not found");
      await pool.query(`UPDATE task_dag_nodes SET node_status = 'DONE' WHERE id = $1`, [node.id]);

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/manual-takeover`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(409);
    });

    it("a paused node is excluded from advanceDag's terminal sync and completion check — the DAG never becomes COMPLETED while it stays paused", async () => {
      const { advanceDag } = await import("./service.js");
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Paused node blocks completion",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node?.task_id) throw new Error("node/task not found");

      const takeoverResponse = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/manual-takeover`,
        headers: { cookie },
      });
      expect(takeoverResponse.statusCode).toBe(200);

      // Even though the underlying task reaches a real terminal status,
      // the paused node must not be synced/counted by advanceDag.
      await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [node.task_id]);
      const result = await advanceDag(pool, dagId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.syncedNodeIds).toHaveLength(0);
      expect(result.dagCompleted).toBe(false);

      const after = await nodeRowsByTitle(dagId);
      expect(after.get("Only step")?.node_status).toBe("MANUAL_TAKEOVER");

      const { rows: dagRows } = await pool.query<{ status: string }>(
        `SELECT status FROM task_dags WHERE id = $1`,
        [dagId],
      );
      expect(dagRows[0]?.status).toBe("ACTIVE");
    });
  });

  describe("POST /dags/:dagId/nodes/:nodeId/retry", () => {
    async function makeFailedNode(cookie: string): Promise<{ dagId: string; nodeId: string }> {
      const dagId = await createAndActivateDag(cookie, {
        title: "Retry scenario",
        category: "writing",
        totalBudget: "200",
        nodes: [
          baseNode({ key: "a", title: "Step A" }),
          baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
        ],
      });
      const before = await nodeRowsByTitle(dagId);
      const stepA = before.get("Step A");
      if (!stepA?.task_id) throw new Error("Step A has no task");
      // Same "preserve the originally granted duration" precondition
      // advance.integration.test.ts's own rematch test establishes.
      await pool.query(
        `UPDATE task_dag_nodes SET delivery_deadline = now() - interval '2 days' WHERE id = $1`,
        [stepA.id],
      );
      await pool.query(`UPDATE tasks SET created_at = now() - interval '9 days' WHERE id = $1`, [
        stepA.task_id,
      ]);
      await pool.query(`UPDATE tasks SET status = 'REFUNDED' WHERE id = $1`, [stepA.task_id]);
      await pool.query(`UPDATE task_dag_nodes SET node_status = 'FAILED' WHERE id = $1`, [
        stepA.id,
      ]);
      return { dagId, nodeId: stepA.id };
    }

    it("creates a brand-new real task for a terminally-FAILED node — sibling/downstream nodes are unaffected", async () => {
      const cookie = await login(account);
      const { dagId, nodeId } = await makeFailedNode(cookie);
      const before = await nodeRowsByTitle(dagId);
      const oldTaskId = before.get("Step A")?.task_id;

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${nodeId}/retry`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { activatedNodeId: string; taskId: string };
      expect(body.activatedNodeId).toBe(nodeId);
      expect(body.taskId).not.toBe(oldTaskId);

      const after = await nodeRowsByTitle(dagId);
      expect(after.get("Step A")?.node_status).toBe("TASK_ACTIVE");
      expect(after.get("Step A")?.task_id).toBe(body.taskId);

      const { rows: newTaskRows } = await pool.query<{ status: string; delivery_deadline: Date }>(
        `SELECT status, delivery_deadline FROM tasks WHERE id = $1`,
        [body.taskId],
      );
      expect(newTaskRows[0]?.status).toBe("DRAFT");
      expect(newTaskRows[0]?.delivery_deadline.getTime()).toBeGreaterThan(Date.now());

      // Old task is an untouched historical record.
      const { rows: oldTaskRows } = await pool.query<{ status: string }>(
        `SELECT status FROM tasks WHERE id = $1`,
        [oldTaskId],
      );
      expect(oldTaskRows[0]?.status).toBe("REFUNDED");

      // Step B (downstream, still PENDING) is completely unaffected.
      expect(after.get("Step B")?.node_status).toBe("PENDING");
      expect(after.get("Step B")?.task_id).toBeNull();
    });

    it("N4 real finding (P1): retrying a FAILED node in an already-COMPLETED DAG revives the DAG to ACTIVE so the poller resumes watching it", async () => {
      const { advanceDag } = await import("./service.js");
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Retry revives a completed DAG",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const before = await nodeRowsByTitle(dagId);
      const onlyStep = before.get("Only step");
      if (!onlyStep?.task_id) throw new Error("node has no task");

      await pool.query(
        `UPDATE task_dag_nodes SET delivery_deadline = now() - interval '2 days' WHERE id = $1`,
        [onlyStep.id],
      );
      await pool.query(`UPDATE tasks SET created_at = now() - interval '9 days' WHERE id = $1`, [
        onlyStep.task_id,
      ]);
      await pool.query(`UPDATE tasks SET status = 'REFUNDED' WHERE id = $1`, [onlyStep.task_id]);

      // advanceDag's own terminal-sync + completion phase (repository.ts)
      // marks the single node FAILED and, since nothing else is left
      // unfinished, transitions the whole DAG to COMPLETED — the real
      // precondition this finding is about, not a fabricated DB state.
      const advanceResult = await advanceDag(pool, dagId);
      expect(advanceResult.ok).toBe(true);
      if (!advanceResult.ok) throw new Error("unreachable");
      expect(advanceResult.dagCompleted).toBe(true);
      const { rows: completedDagRows } = await pool.query<{ status: string }>(
        `SELECT status FROM task_dags WHERE id = $1`,
        [dagId],
      );
      expect(completedDagRows[0]?.status).toBe("COMPLETED");

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${onlyStep.id}/retry`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);

      const { rows: revivedDagRows } = await pool.query<{ status: string }>(
        `SELECT status FROM task_dags WHERE id = $1`,
        [dagId],
      );
      expect(revivedDagRows[0]?.status).toBe("ACTIVE");

      const { listActiveDagIds } = await import("./repository.js");
      const activeIds = await listActiveDagIds(pool);
      expect(activeIds).toContain(dagId);
    });

    it("refuses to retry a node in a DAG that was never activated (DRAFT) with 409", async () => {
      const cookie = await login(account);
      const createResponse = await app.inject({
        method: "POST",
        url: "/dags",
        headers: { cookie },
        payload: {
          title: "Draft, never activated",
          category: "writing",
          totalBudget: "100",
          nodes: [baseNode({ key: "a", title: "Only step" })],
        },
      });
      expect(createResponse.statusCode).toBe(201);
      const dagId = createResponse.json().id as string;
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node) throw new Error("node not found");

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/retry`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(409);
    });

    it("refuses to retry a node that is not terminally FAILED with 409", async () => {
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Cannot retry an active node",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node) throw new Error("node not found");

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/retry`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(409);

      const after = await nodeRowsByTitle(dagId);
      expect(after.get("Only step")?.node_status).toBe("TASK_ACTIVE");
      expect(after.get("Only step")?.task_id).toBe(node.task_id);
    });

    it("rejects a non-requester's retry attempt with 403", async () => {
      const cookie = await login(account);
      const { dagId, nodeId } = await makeFailedNode(cookie);

      const otherCookie = await login(otherAccount);
      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${nodeId}/retry`,
        headers: { cookie: otherCookie },
      });
      expect(response.statusCode).toBe(403);

      const after = await nodeRowsByTitle(dagId);
      expect(after.get("Step A")?.node_status).toBe("FAILED");
    });
  });

  describe("POST /dags/:dagId/nodes/:nodeId/cancel", () => {
    it("returns 404 when the DAG does not exist", async () => {
      const cookie = await login(account);
      const response = await app.inject({
        method: "POST",
        url: `/dags/00000000-0000-0000-0000-000000000000/nodes/00000000-0000-0000-0000-000000000000/cancel`,
        headers: { cookie },
        payload: { txHash: `0x${"1".repeat(64)}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it("rejects a non-requester with 403 before ever attempting chain verification", async () => {
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Cancel forbidden",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node) throw new Error("node not found");

      const otherCookie = await login(otherAccount);
      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/cancel`,
        headers: { cookie: otherCookie },
        payload: { txHash: `0x${"1".repeat(64)}` },
      });
      expect(response.statusCode).toBe(403);

      const after = await nodeRowsByTitle(dagId);
      expect(after.get("Only step")?.node_status).toBe("TASK_ACTIVE");
    });

    it("returns 409 when the node has no task_id yet (still PENDING)", async () => {
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Cancel before ready",
        category: "writing",
        totalBudget: "200",
        nodes: [
          baseNode({ key: "a", title: "Step A" }),
          baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
        ],
      });
      const stepB = (await nodeRowsByTitle(dagId)).get("Step B");
      if (!stepB) throw new Error("Step B not found");
      expect(stepB.task_id).toBeNull();

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${stepB.id}/cancel`,
        headers: { cookie },
        payload: { txHash: `0x${"1".repeat(64)}` },
      });
      expect(response.statusCode).toBe(409);
    });

    it("N4 real finding (round 2, P1): returns 409 for a MANUAL_TAKEOVER node even though it still carries a task_id — never reaches chain verification", async () => {
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Cancel a paused node",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node?.task_id) throw new Error("node has no task");

      const takeoverResponse = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/manual-takeover`,
        headers: { cookie },
      });
      expect(takeoverResponse.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/cancel`,
        headers: { cookie },
        payload: { txHash: `0x${"1".repeat(64)}` },
      });
      expect(response.statusCode).toBe(409);

      // The real bug this test guards against: the task must stay
      // whatever it was — cancellation must never even be attempted.
      const { rows: taskRows } = await pool.query<{ status: string }>(
        `SELECT status FROM tasks WHERE id = $1`,
        [node.task_id],
      );
      expect(taskRows[0]?.status).not.toBe("CANCELLED");
    });

    it("N4 real finding (round 2, T-1707 review): withLockedActiveDagNode releases its lock BEFORE fn runs — a concurrent manual-takeover is never blocked by fn's own duration", async () => {
      // T-1706 round 1 fixed a race by holding the lock across the whole
      // `fn` call — but that meant `fn` (which calls `verifyCancellation`,
      // itself acquiring a SEPARATE connection from the same pool) ran
      // while still holding an outer connection: a real, reproducible
      // pool-exhaustion deadlock under a small/saturated pool, a strictly
      // worse problem than the race it fixed. This test proves the
      // corrected behavior: the lock is scoped to the eligibility check
      // ONLY (fast, no nested pool acquisition), released before `fn`
      // starts — so `fn`'s own duration can never block anything else.
      const { withLockedActiveDagNode } = await import("./repository.js");
      const { normalizeAddress } = await import("../auth/nonce.store.js");
      const cookie = await login(account);
      const dagId = await createAndActivateDag(cookie, {
        title: "Lock releases before fn runs",
        category: "writing",
        totalBudget: "100",
        nodes: [baseNode({ key: "a", title: "Only step" })],
      });
      const node = (await nodeRowsByTitle(dagId)).get("Only step");
      if (!node?.task_id) throw new Error("node has no task");

      const order: string[] = [];
      let releaseFn: () => void = () => {};
      const fnBlocked = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });

      const lockedPromise = withLockedActiveDagNode(
        pool,
        dagId,
        node.id,
        normalizeAddress(account.address),
        async (taskId) => {
          order.push("fn-started");
          await fnBlocked;
          order.push("fn-done");
          return taskId;
        },
      );

      // Give the eligibility check + fn-start time to run, then attempt a
      // concurrent manual-takeover WHILE fn is still deliberately blocked.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(order).toEqual(["fn-started"]);

      const takeoverResponse = await app.inject({
        method: "POST",
        url: `/dags/${dagId}/nodes/${node.id}/manual-takeover`,
        headers: { cookie },
      });
      order.push(`takeover-response:${takeoverResponse.statusCode}`);

      // The real proof: manual-takeover completed WHILE fn was still
      // blocked — no pool-level wait, no deadlock. (Its own eligibility
      // check correctly still sees TASK_ACTIVE, since fn hasn't changed
      // anything yet.)
      expect(order).toEqual(["fn-started", "takeover-response:200"]);
      expect(takeoverResponse.statusCode).toBe(200);

      releaseFn();
      const lockedResult = await lockedPromise;
      expect(lockedResult).toEqual({ outcome: "ran", result: node.task_id });
    });
  });
});
