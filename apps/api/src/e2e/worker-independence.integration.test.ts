import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { createPostgresQueueAdapter } from "@agent-market/queue";
import { buildApp } from "../app.js";
import { runMigrations } from "../db/migrate.js";

/**
 * AC-1804's real process-independence proof: a genuinely SEPARATE
 * `apps/worker` OS process (spawned via `tsx`, not simulated in-process)
 * consumes real messages; killing it does not affect a real, running
 * `apps/api` instance's ability to answer requests; restarting it resumes
 * real consumption. The OTHER half of AC-1804 — "a message being
 * processed but not completed gets reprocessed" — is proven precisely and
 * deterministically at the queue-mechanism level in
 * `packages/queue/test/postgres-adapter.integration.test.ts` (a real
 * spawned-process timing race for THAT specific claim would be flaky by
 * construction; the queue-level test controls the exact "never completes"
 * condition directly instead).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../worker");

const tsxBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../worker/node_modules/.bin/tsx",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

async function waitForCondition(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitForCondition: condition never became true within ${timeoutMs}ms`);
}

runIfOptedIn("apps/worker process independence (integration, T-1804)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let queue: ReturnType<typeof createPostgresQueueAdapter>;
  let workerProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
  const queueName = `worker-independence-test-${randomUUID()}`;

  function spawnWorker(): ChildProcessByStdio<null, Readable, Readable> {
    return spawn(tsxBin, ["src/main.ts"], {
      cwd: workerDir,
      env: {
        ...process.env,
        DATABASE_URL: requireTestDatabaseUrl(),
        WORKER_QUEUE_NAME: queueName,
        WORKER_DLQ_NAME: `${queueName}-dlq`,
        WORKER_RETRY_LIMIT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async function waitForWorkerReady(proc: ChildProcessByStdio<null, Readable, Readable>) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("worker never printed startup line")),
        15_000,
      );
      proc.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("apps/worker started")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.once("error", reject);
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool, logger: false });
    await app.ready();
    queue = createPostgresQueueAdapter(requireTestDatabaseUrl());
  }, 30_000);

  afterAll(async () => {
    workerProcess?.kill("SIGKILL");
    await app?.close();
    await queue?.stop();
    await pool.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  it("AC-1804: a real spawned Worker process consumes messages; killing it does not affect apps/api; restarting it resumes consumption", async () => {
    workerProcess = spawnWorker();
    await waitForWorkerReady(workerProcess);

    // Real consumption by the real spawned process. apps/worker's own
    // handler is wrapped in `withIdempotentConsumption`, which expects
    // the queue payload to be a real `EventEnvelope<T>` ({id, payload})
    // — the same shape `relayPendingMessages` publishes in production
    // (T-1802) — so this test publishes that shape directly rather than
    // going through the outbox/relay, which isn't this Task's own
    // concern.
    const firstMessageId = randomUUID();
    await queue.publish(queueName, { id: firstMessageId, payload: { note: "first" } });
    await waitForCondition(async () => {
      const { rows } = await pool.query(
        `SELECT 1 FROM processed_events WHERE consumer_name = 'worker' AND event_id = $1`,
        [firstMessageId],
      );
      return rows.length > 0;
    }, 10_000);

    // Kill the Worker process — genuinely gone, not just unsubscribed.
    const exitPromise = new Promise<void>((resolve) => {
      workerProcess?.once("exit", () => resolve());
    });
    workerProcess.kill("SIGKILL");
    await exitPromise;

    // apps/api answers real requests while the Worker is completely down.
    const healthResponse = await app.inject({ method: "GET", url: "/health" });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({ status: "ok" });

    // A message published while the Worker is down waits durably in the
    // queue (pg-boss, itself just Postgres) — nothing is lost.
    const secondMessageId = randomUUID();
    await queue.publish(queueName, { id: secondMessageId, payload: { note: "second" } });

    // Restart — a fresh process, same queue.
    workerProcess = spawnWorker();
    await waitForWorkerReady(workerProcess);

    // The message published during downtime gets picked up and
    // processed once the Worker is back.
    await waitForCondition(async () => {
      const { rows } = await pool.query(
        `SELECT 1 FROM processed_events WHERE consumer_name = 'worker' AND event_id = $1`,
        [secondMessageId],
      );
      return rows.length > 0;
    }, 10_000);
  }, 45_000);
});
