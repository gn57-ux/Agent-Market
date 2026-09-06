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
 * Real-Postgres integration test for T-1703's `advanceDag` (the "临时同步
 * 轮询" stand-in for Feature 18's not-yet-built event consumer — see
 * repository.ts's own `advanceDagNodes` doc comment). Directly manipulates
 * `tasks.status` via SQL to simulate a task reaching a real terminal state
 * (RELEASED/REFUNDED/CANCELLED) rather than re-running Feature 10's full
 * real on-chain settlement flow — that flow's own correctness is already
 * real-e2e-tested (`full-lifecycle.hardhat.e2e.test.ts`, T-1007); this file
 * tests DAG-specific reactions to those terminal states, matching this
 * project's own precedent for not duplicating already-covered mechanics
 * (see that file's own "deliberately NOT re-covered here" note).
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

runIfOptedIn("advanceDag (integration, T-1703)", () => {
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

  let nextEventSeed = 0;
  /** Records the real, distinguishing on-chain event a REFUNDED task's
   * status transition actually came from — matching how the real
   * verification flow (tasks/service.ts's `verifySettlement`) always
   * writes one before updating `tasks.status`. Fabricated-but-valid-format
   * hash/log fields (never real chain data) — this test only needs
   * `event_name` to be real and queryable, not a genuine receipt. */
  async function insertChainEvent(taskId: string, eventName: string): Promise<void> {
    nextEventSeed += 1;
    const suffix = nextEventSeed.toString(16).padStart(4, "0");
    await pool.query(
      `INSERT INTO chain_events (chain_id, block_hash, transaction_hash, log_index, event_name, task_id, payload)
         VALUES (31337, $1, $2, 0, $3, $4, '{}'::jsonb)`,
      [`0x${"a".repeat(60)}${suffix}`, `0x${"b".repeat(60)}${suffix}`, eventName, taskId],
    );
  }

  it("returns not_found for a nonexistent DAG", async () => {
    const result = await advanceDag(pool, "00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("refuses to advance a DAG that is still DRAFT", async () => {
    const cookie = await login();
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: { title: "Draft", category: "writing", totalBudget: "100", nodes: [baseNode()] },
    });
    const dagId = createResponse.json().id as string;

    const result = await advanceDag(pool, dagId);
    expect(result).toEqual({
      ok: false,
      reason: "NOT_ACTIVE",
      detail: "DAG 当前状态为 DRAFT，只有 ACTIVE 状态的 DAG 可以推进节点",
    });
  });

  it("serial chain: as each node's task RELEASES, the next node activates in turn (a real task is created for it)", async () => {
    const dagId = await createAndActivateDag({
      title: "Serial",
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
    expect(statuses.get("Step B")?.node_status).toBe("PENDING");
    expect(statuses.get("Step C")?.node_status).toBe("PENDING");

    const stepATaskId = statuses.get("Step A")?.task_id;
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [stepATaskId]);

    const firstAdvance = await advanceDag(pool, dagId);
    expect(firstAdvance.ok).toBe(true);
    if (!firstAdvance.ok) throw new Error("unreachable");
    expect(firstAdvance.syncedNodeIds).toHaveLength(1);
    expect(firstAdvance.activatedNodeIds).toHaveLength(1);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Step A")?.node_status).toBe("DONE");
    expect(statuses.get("Step B")?.node_status).toBe("TASK_ACTIVE");
    expect(statuses.get("Step B")?.task_id).toBeTruthy();
    expect(statuses.get("Step C")?.node_status).toBe("PENDING");
    expect(statuses.get("Step C")?.task_id).toBeNull();

    const stepBTaskId = statuses.get("Step B")?.task_id;
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [stepBTaskId]);
    const secondAdvance = await advanceDag(pool, dagId);
    expect(secondAdvance.ok).toBe(true);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Step B")?.node_status).toBe("DONE");
    expect(statuses.get("Step C")?.node_status).toBe("TASK_ACTIVE");
    expect(statuses.get("Step C")?.task_id).toBeTruthy();
  });

  it("AC-1702: an aggregate node with two parallel preconditions cannot activate until BOTH reach a terminal state", async () => {
    const dagId = await createAndActivateDag({
      title: "Parallel + aggregate",
      category: "writing",
      totalBudget: "300",
      nodes: [
        baseNode({ key: "a", title: "Parallel A", role: "PARALLEL" }),
        baseNode({ key: "b", title: "Parallel B", role: "PARALLEL" }),
        baseNode({ key: "c", title: "Aggregate C", role: "AGGREGATE", dependsOn: ["a", "b"] }),
      ],
    });

    let statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Parallel A")?.node_status).toBe("TASK_ACTIVE");
    expect(statuses.get("Parallel B")?.node_status).toBe("TASK_ACTIVE");
    expect(statuses.get("Aggregate C")?.node_status).toBe("PENDING");

    // Only A releases — the aggregate must NOT activate yet (the whole
    // point of this Task's AC-1702 verification).
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Parallel A")?.task_id,
    ]);
    const afterOnlyA = await advanceDag(pool, dagId);
    expect(afterOnlyA.ok).toBe(true);
    if (!afterOnlyA.ok) throw new Error("unreachable");
    expect(afterOnlyA.activatedNodeIds).toHaveLength(0);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Parallel A")?.node_status).toBe("DONE");
    expect(statuses.get("Parallel B")?.node_status).toBe("TASK_ACTIVE");
    expect(statuses.get("Aggregate C")?.node_status).toBe("PENDING");
    expect(statuses.get("Aggregate C")?.task_id).toBeNull();

    // Now B also releases — both preconditions DONE, aggregate may activate.
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Parallel B")?.task_id,
    ]);
    const afterBothDone = await advanceDag(pool, dagId);
    expect(afterBothDone.ok).toBe(true);
    if (!afterBothDone.ok) throw new Error("unreachable");
    expect(afterBothDone.activatedNodeIds).toHaveLength(1);

    statuses = await nodeStatusByTitle(dagId);
    expect(statuses.get("Aggregate C")?.node_status).toBe("TASK_ACTIVE");
    expect(statuses.get("Aggregate C")?.task_id).toBeTruthy();
  });

  it("a REFUNDED task with no matching (non-delivery-timeout) settlement cause does not rematch and marks the node FAILED — downstream nodes are NOT unblocked by it", async () => {
    const dagId = await createAndActivateDag({
      title: "Failure does not propagate",
      category: "writing",
      totalBudget: "200",
      nodes: [
        baseNode({ key: "a", title: "Step A" }),
        baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
      ],
    });

    const statuses = await nodeStatusByTitle(dagId);
    const stepATaskId = statuses.get("Step A")?.task_id;
    if (!stepATaskId) throw new Error("Step A has no task_id");
    // N4 real finding (round 1): REFUNDED alone does not mean "Agent went
    // overdue" — a dispute resolved in the requester's favor also produces
    // REFUNDED (tasks/service.ts's DISPUTE_RESOLVED_SUPPORT_REQUESTER
    // path), a scenario T-1704 must NOT auto-rematch (a human arbitrator
    // already ruled). Recording the real distinguishing event this way
    // (rather than an expired-deadline check, which the real
    // DeliveryTimeoutClaimed precondition makes meaningless — see
    // repository.ts's own doc comment) is the actual mechanism that gates
    // rematch.
    await insertChainEvent(stepATaskId, "DisputeResolved");
    await pool.query(`UPDATE tasks SET status = 'REFUNDED' WHERE id = $1`, [stepATaskId]);

    const result = await advanceDag(pool, dagId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.syncedNodeIds).toHaveLength(1);
    expect(result.rematchedNodeIds).toHaveLength(0);
    expect(result.activatedNodeIds).toHaveLength(0);
    // B is stuck PENDING forever (its only precondition FAILED, not
    // DONE) — the DAG has not actually finished executing.
    expect(result.dagCompleted).toBe(false);

    const after = await nodeStatusByTitle(dagId);
    expect(after.get("Step A")?.node_status).toBe("FAILED");
    expect(after.get("Step B")?.node_status).toBe("PENDING");
    expect(after.get("Step B")?.task_id).toBeNull();
  });

  it("N4 real finding (round 2, P1): once every node reaches a terminal state, the DAG transitions ACTIVE -> COMPLETED and stops appearing as an active DAG", async () => {
    const dagId = await createAndActivateDag({
      title: "Single node, fully completes",
      category: "writing",
      totalBudget: "100",
      nodes: [baseNode({ key: "a", title: "Only step" })],
    });
    const statuses = await nodeStatusByTitle(dagId);
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      statuses.get("Only step")?.task_id,
    ]);

    const result = await advanceDag(pool, dagId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.dagCompleted).toBe(true);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(rows[0]?.status).toBe("COMPLETED");

    // A second advance call now correctly refuses — the DAG is no longer
    // ACTIVE, so a poller tick that reaches it (e.g. a race with the
    // ACTIVE->COMPLETED transition) does nothing further.
    const second = await advanceDag(pool, dagId);
    expect(second).toEqual({
      ok: false,
      reason: "NOT_ACTIVE",
      detail: "DAG 当前状态为 COMPLETED，只有 ACTIVE 状态的 DAG 可以推进节点",
    });
  });

  it("N4 real finding (round 2, P2): a blocked downstream node's activation failure does NOT roll back an upstream node's real DONE sync from the same tick", async () => {
    const dagId = await createAndActivateDag({
      title: "Upstream sync must survive a blocked downstream",
      category: "writing",
      totalBudget: "200",
      nodes: [
        baseNode({ key: "a", title: "Step A" }),
        baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
      ],
    });
    const before = await nodeStatusByTitle(dagId);

    // Give Step B an already-past deadline BEFORE it ever becomes ready —
    // simulates a real deployment window where B's deadline elapsed while
    // A was still running.
    await pool.query(
      `UPDATE task_dag_nodes SET delivery_deadline = now() - interval '1 day' WHERE dag_id = $1 AND title = 'Step B'`,
      [dagId],
    );
    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [
      before.get("Step A")?.task_id,
    ]);

    const result = await advanceDag(pool, dagId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The real bug this test guards against: the previous version threw
    // this away (rolled back the whole transaction) whenever the blocked
    // branch below was hit.
    expect(result.syncedNodeIds).toHaveLength(1);
    expect(result.blocked).toEqual({
      reason: "NODE_DEADLINE_EXPIRED",
      detail: expect.stringContaining("node_deadline_expired") as unknown as string,
    });

    const after = await nodeStatusByTitle(dagId);
    // Step A's real completion is genuinely committed, not discarded.
    expect(after.get("Step A")?.node_status).toBe("DONE");
    expect(after.get("Step B")?.node_status).toBe("PENDING");
    expect(after.get("Step B")?.task_id).toBeNull();
  });

  it("AC-1703: a node whose Agent went overdue (REFUNDED) with a still-valid deadline automatically rematches — a real new task, not FAILED — and other nodes are unaffected", async () => {
    const dagId = await createAndActivateDag({
      title: "Rematch does not affect siblings",
      category: "writing",
      totalBudget: "200",
      nodes: [
        baseNode({ key: "a", title: "Overdue node" }),
        baseNode({ key: "b", title: "Unrelated sibling", role: "PARALLEL" }),
      ],
    });
    const before = await nodeStatusByTitle(dagId);
    const oldTaskId = before.get("Overdue node")?.task_id;
    const siblingTaskId = before.get("Unrelated sibling")?.task_id;
    if (!oldTaskId || !siblingTaskId) throw new Error("both nodes should already have a task");

    // N4 real finding (round 1): a real DeliveryTimeoutClaimed can only be
    // claimed AFTER delivery_deadline has passed — so both the node's
    // stored deadline AND the old task's `created_at` are moved into the
    // past here (the task was really "created 9 days ago with a 7-day
    // deadline, now 2 days overdue" — not just the deadline alone, or the
    // computed original-duration-preserving new deadline below would come
    // out negative).
    await pool.query(
      `UPDATE task_dag_nodes SET delivery_deadline = now() - interval '2 days' WHERE dag_id = $1 AND title = 'Overdue node'`,
      [dagId],
    );
    await pool.query(`UPDATE tasks SET created_at = now() - interval '9 days' WHERE id = $1`, [
      oldTaskId,
    ]);
    await insertChainEvent(oldTaskId, "DeliveryTimeoutClaimed");
    await pool.query(`UPDATE tasks SET status = 'REFUNDED' WHERE id = $1`, [oldTaskId]);

    const result = await advanceDag(pool, dagId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rematchedNodeIds).toHaveLength(1);
    // A rematched node is never visibly synced to FAILED.
    expect(result.syncedNodeIds).toHaveLength(0);

    const after = await nodeStatusByTitle(dagId);
    expect(after.get("Overdue node")?.node_status).toBe("TASK_ACTIVE");
    const newTaskId = after.get("Overdue node")?.task_id;
    expect(newTaskId).toBeTruthy();
    expect(newTaskId).not.toBe(oldTaskId);

    // The new task's deadline is genuinely in the future — proves the
    // "compute a fresh deadline" fix, not a reuse of the now-past stored
    // value.
    const { rows: newTaskRows } = await pool.query<{ delivery_deadline: Date }>(
      `SELECT delivery_deadline FROM tasks WHERE id = $1`,
      [newTaskId],
    );
    expect(newTaskRows[0]?.delivery_deadline.getTime()).toBeGreaterThan(Date.now());

    // The old (REFUNDED) task itself is untouched — a real historical
    // record, just no longer pointed to by the node.
    const { rows: oldTaskRows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [oldTaskId],
    );
    expect(oldTaskRows[0]?.status).toBe("REFUNDED");

    // The unrelated sibling node/task is completely unaffected — AC-1703's
    // core assertion.
    expect(after.get("Unrelated sibling")?.node_status).toBe("TASK_ACTIVE");
    expect(after.get("Unrelated sibling")?.task_id).toBe(siblingTaskId);
  });

  it("N4 real finding (P2, T-1706 review): a legacy node with description=NULL that goes overdue is excluded from auto-rematch — no crash, real FAILED sync, sibling unaffected", async () => {
    const dagId = await createAndActivateDag({
      title: "Legacy NULL description does not crash the tick",
      category: "writing",
      totalBudget: "200",
      nodes: [
        baseNode({ key: "a", title: "Overdue legacy node" }),
        baseNode({ key: "b", title: "Unrelated sibling", role: "PARALLEL" }),
      ],
    });
    const before = await nodeStatusByTitle(dagId);
    const oldTaskId = before.get("Overdue legacy node")?.task_id;
    const siblingTaskId = before.get("Unrelated sibling")?.task_id;
    if (!oldTaskId || !siblingTaskId) {
      throw new Error("both nodes should already have a task");
    }
    const { rows: overdueNodeRows } = await pool.query<{ id: string }>(
      `SELECT id FROM task_dag_nodes WHERE dag_id = $1 AND title = 'Overdue legacy node'`,
      [dagId],
    );
    const overdueNodeId = overdueNodeRows[0]?.id;
    if (!overdueNodeId) throw new Error("overdue node not found");

    // Simulates a real pre-0025 row: description forced back to NULL
    // (0025's own forward migration only converts the legacy '' placeholder
    // — this directly reproduces the shape a genuinely-legacy row would
    // have, without re-running migrations).
    await pool.query(`UPDATE task_dag_nodes SET description = NULL WHERE id = $1`, [overdueNodeId]);
    await pool.query(
      `UPDATE task_dag_nodes SET delivery_deadline = now() - interval '2 days' WHERE id = $1`,
      [overdueNodeId],
    );
    await pool.query(`UPDATE tasks SET created_at = now() - interval '9 days' WHERE id = $1`, [
      oldTaskId,
    ]);
    await insertChainEvent(oldTaskId, "DeliveryTimeoutClaimed");
    await pool.query(`UPDATE tasks SET status = 'REFUNDED' WHERE id = $1`, [oldTaskId]);

    // The real bug this test guards against: without the fix, this call
    // throws (createTasksForReadyNodes' own missing-field check), which
    // propagates as an unhandled rejection rolling back the whole tick.
    const result = await advanceDag(pool, dagId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rematchedNodeIds).toHaveLength(0);
    expect(result.syncedNodeIds).toContain(overdueNodeId);

    const after = await nodeStatusByTitle(dagId);
    // Real, honest FAILED (not a crash, not silently stuck TASK_ACTIVE) —
    // the terminal-sync phase has no field dependency, so it still works
    // even though rematch was skipped.
    expect(after.get("Overdue legacy node")?.node_status).toBe("FAILED");
    expect(after.get("Overdue legacy node")?.task_id).toBe(oldTaskId);

    // The unrelated sibling is completely unaffected by this legacy-data
    // edge case.
    expect(after.get("Unrelated sibling")?.node_status).toBe("TASK_ACTIVE");
    expect(after.get("Unrelated sibling")?.task_id).toBe(siblingTaskId);
  });
});
