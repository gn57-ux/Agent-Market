import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { startDagPoller, type DagPollerHandle } from "./dag-poller.js";

/**
 * N4 real finding (T-1703): `advanceDag` (the actual node-state-
 * advancement logic) existed but was never invoked by anything except
 * tests — no route, no timer, nothing wired into `server.ts`. This file
 * proves the fix at the level that finding actually complained about: a
 * multi-node DAG genuinely progresses to its second node WITHOUT any test
 * code calling `advanceDag` directly — only `startDagPoller`'s real
 * background timer does, exactly as it would in the real running process.
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
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runIfOptedIn("startDagPoller (integration, T-1703)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let pollerHandle: DagPollerHandle;
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
    pollerHandle = startDagPoller({ pool, intervalMs: 100 });
  });

  afterAll(async () => {
    await pollerHandle.stop();
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

  it("a real background tick — not a direct advanceDag call — activates a serial chain's second node once the first task RELEASES", async () => {
    const cookie = await login();
    const createResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Poller-driven",
        category: "writing",
        totalBudget: "200",
        nodes: [
          baseNode({ key: "a", title: "Step A" }),
          baseNode({ key: "b", title: "Step B", dependsOn: ["a"] }),
        ],
      },
    });
    const dagId = createResponse.json().id as string;
    await app.inject({ method: "POST", url: `/dags/${dagId}/activate`, headers: { cookie } });

    const { rows: beforeRows } = await pool.query<{ title: string; task_id: string }>(
      `SELECT title, task_id FROM task_dag_nodes WHERE dag_id = $1 AND title = 'Step A'`,
      [dagId],
    );
    const stepATaskId = beforeRows[0]?.task_id;
    if (!stepATaskId) throw new Error("Step A has no task_id after activation");

    await pool.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [stepATaskId]);

    // No call to advanceDag/advanceDagNodes here — only the real
    // background poller (started in beforeAll, ticking every 100ms) can
    // make this pass.
    let stepBActive = false;
    for (let attempt = 0; attempt < 20 && !stepBActive; attempt += 1) {
      await sleep(50);
      const { rows } = await pool.query<{ node_status: string }>(
        `SELECT node_status FROM task_dag_nodes WHERE dag_id = $1 AND title = 'Step B'`,
        [dagId],
      );
      stepBActive = rows[0]?.node_status === "TASK_ACTIVE";
    }

    expect(stepBActive).toBe(true);
  }, 15_000);
});
