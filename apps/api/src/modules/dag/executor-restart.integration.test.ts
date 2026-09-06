import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { startDagPoller, type DagPollerHandle, type DagPollTickSummary } from "./dag-poller.js";

/**
 * T-1708 — AC-1706's own verification requirement: "清空/重启执行器后，新
 * 实例可以正确读取真实状态继续推进". design.md 决策 2 already chose the
 * "internal simple executor" (a pure poller reading Postgres/chain state
 * fresh every tick, see `dag-poller.ts`'s own doc comment) specifically so
 * this property would hold by construction — this file is the real proof,
 * not a new mechanism: it kills a poller instance mid-DAG, starts a
 * COMPLETELY SEPARATE poller instance (its own `Pool`, its own
 * `startDagPoller` call, zero shared in-process memory with the first —
 * as close to "a new OS process" as a single test file can get), and
 * shows the DAG finishes correctly anyway.
 *
 * Real terminal-state transitions are driven by direct SQL (matching
 * `advance.integration.test.ts`'s own established precedent for this
 * module — chain-settlement mechanics are already proven elsewhere,
 * `full-lifecycle.hardhat.e2e.test.ts`; this file is only about executor
 * restart-resilience, not re-proving chain flows).
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

/**
 * N4 real finding (P2): the original version let a rejecting `predicate`
 * (e.g. a query against an already-closed pool) escape as an unhandled
 * rejection, leaving the outer promise pending forever — the test would
 * hang until Vitest's own timeout, masking the real underlying error
 * entirely. Every predicate call is now wrapped so a thrown/rejected
 * predicate immediately rejects `waitFor` itself with the real error.
 */
function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      predicate()
        .then((satisfied) => {
          if (satisfied) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error(`waitFor: predicate never became true within ${timeoutMs}ms`));
            return;
          }
          setTimeout(check, 25);
        })
        .catch(reject);
    };
    check();
  });
}

runIfOptedIn("executor restart resilience (integration, T-1708, AC-1706)", () => {
  // `poolA`/`appA` stand in for the process that creates and starts
  // advancing the DAG; `poolB`/`appB` (created fresh, later, independently
  // — never sharing a `Pool` object with A) stand in for a completely
  // separate process instance restarted after A is gone. Only real
  // Postgres state (never anything in A's memory) is available to B.
  let poolA: Pool;
  let poolB: Pool | undefined;
  let appA: ReturnType<typeof buildApp>;
  let pollerA: DagPollerHandle | undefined;
  let pollerB: DagPollerHandle | undefined;
  // N4 real finding (P2): the test itself deliberately tears A down mid-
  // test (that IS the scenario under test) — but if an assertion or
  // `waitFor` throws BEFORE that point, the original version's `afterAll`
  // never stopped `pollerA`/closed `appA`/ended `poolA` at all, leaving a
  // live poller still querying the pool while `afterAll` concurrently
  // dropped the schema out from under it, and a leaked open `Pool` that
  // could keep the test process alive. These flags let `afterAll`
  // idempotently finish whatever the test didn't get to, regardless of
  // where it failed.
  let poolAEnded = false;
  let appAClosed = false;
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    poolA = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(poolA, migrationsDir);
    appA = buildApp({ pool: poolA });
  });

  // A single test in this suite (its own multi-instance-restart narrative
  // doesn't compose with a shared-fixture "run before/after each test"
  // pattern — instance A is deliberately torn down mid-test) — cleanup
  // happens once, in `afterAll`, via a DEDICATED pool (never `poolA`,
  // which the test itself ends; never `poolB`, which may or may not have
  // been created depending on how far the test got), and is safe to run
  // no matter where the test stopped.
  afterAll(async () => {
    await pollerA?.stop().catch(() => {});
    await pollerB?.stop().catch(() => {});
    if (!appAClosed) {
      await appA?.close().catch(() => {});
    }
    if (!poolAEnded) {
      await poolA?.end().catch(() => {});
    }
    await poolB?.end().catch(() => {});

    const cleanupPool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await cleanupPool.query(DROP_ALL_TABLES_SQL);
    await cleanupPool.end();
  });

  async function login(): Promise<string> {
    const nonceResponse = await appA.inject({
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
    const verifyResponse = await appA.inject({
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

  async function nodeRowsByTitle(
    pool: Pool,
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

  it("AC-1706: a fresh executor instance, sharing NOTHING but Postgres with a killed one, correctly resumes and finishes advancing a DAG", async () => {
    const cookie = await login();
    const createResponse = await appA.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Executor restart proof",
        category: "writing",
        totalBudget: "200",
        nodes: [
          baseNode({ key: "a", title: "Step A" }),
          baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
        ],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const dagId = createResponse.json().id as string;
    const activateResponse = await appA.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(activateResponse.statusCode).toBe(200);

    // Instance A: starts advancing the DAG (real background loop, not a
    // direct `advanceDag` call — the actual production entry point).
    let tickCountA = 0;
    pollerA = startDagPoller({
      pool: poolA,
      intervalMs: 50,
      onTick: () => {
        tickCountA += 1;
      },
    });

    // Wait for at least one real tick from instance A before killing it —
    // proves A genuinely started running, not just that it was never
    // asked to do anything.
    await waitFor(async () => tickCountA >= 1, 2000);

    const before = await nodeRowsByTitle(poolA, dagId);
    const stepATaskId = before.get("Step A")?.task_id;
    if (!stepATaskId) throw new Error("Step A has no task");

    // Step A completes while instance A is still the only thing running.
    await poolA.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [stepATaskId]);
    await waitFor(async () => {
      const rows = await nodeRowsByTitle(poolA, dagId);
      return rows.get("Step A")?.node_status === "DONE" && rows.get("Step B")?.task_id !== null;
    }, 3000);

    const midway = await nodeRowsByTitle(poolA, dagId);
    expect(midway.get("Step A")?.node_status).toBe("DONE");
    expect(midway.get("Step B")?.node_status).toBe("TASK_ACTIVE");
    const stepBTaskId = midway.get("Step B")?.task_id;
    if (!stepBTaskId) throw new Error("Step B has no task");

    // Kill instance A entirely — not just stopping the poller, but
    // discarding everything about it (its `Pool`, its Fastify `app`, its
    // closure variables). Nothing from this point on has access to
    // anything instance A ever held in memory.
    await pollerA.stop();
    await appA.close();
    appAClosed = true;
    await poolA.end();
    poolAEnded = true;

    // Step B completes AFTER instance A is completely gone — proving this
    // isn't "a tick was already in flight," but a genuinely new fact only
    // Postgres (never any process's memory) now records.
    const poolAAfterEnd = new Pool({ connectionString: requireTestDatabaseUrl() });
    await poolAAfterEnd.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [stepBTaskId]);
    await poolAAfterEnd.end();

    // Instance B: a completely independent Pool + poller — the real
    // "reconstruct executor state from Postgres alone" proof. It has never
    // seen this DAG before this line runs.
    const freshPoolB = new Pool({ connectionString: requireTestDatabaseUrl() });
    poolB = freshPoolB;
    let tickCountB = 0;
    let lastSummaryB: DagPollTickSummary | undefined;
    pollerB = startDagPoller({
      pool: freshPoolB,
      intervalMs: 50,
      onTick: (summary) => {
        tickCountB += 1;
        lastSummaryB = summary;
      },
    });

    try {
      await waitFor(async () => {
        const rows = await nodeRowsByTitle(freshPoolB, dagId);
        return rows.get("Step B")?.node_status === "DONE";
      }, 3000);
    } finally {
      await pollerB.stop();
    }

    expect(tickCountB).toBeGreaterThan(0);
    expect(lastSummaryB?.errors).toEqual([]);

    const after = await nodeRowsByTitle(freshPoolB, dagId);
    expect(after.get("Step A")?.node_status).toBe("DONE");
    expect(after.get("Step B")?.node_status).toBe("DONE");

    const { rows: dagRows } = await freshPoolB.query<{ status: string }>(
      `SELECT status FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(dagRows[0]?.status).toBe("COMPLETED");
  });
});
