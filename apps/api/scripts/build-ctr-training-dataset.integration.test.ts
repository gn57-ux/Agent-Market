import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runBuild, FEATURE_VERSION } from "./build-ctr-training-dataset.js";

/**
 * Real-Postgres, real-filesystem integration test for T-1904's CLI script
 * wrapper — proves `runBuild` actually writes a real JSONL file and
 * registers real `ctr_training_datasets` metadata matching it, on top of
 * `dataset-builder.integration.test.ts`'s own coverage of the underlying
 * query logic.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
const TEST_DATASET_DIR = path.resolve(process.cwd(), "var/ctr-training-datasets-test");

runIfOptedIn("build-ctr-training-dataset script (integration, T-1904)", () => {
  let pool: Pool;

  beforeAll(async () => {
    process.env.CTR_DATASET_DIR = "var/ctr-training-datasets-test";
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
    await rm(TEST_DATASET_DIR, { recursive: true, force: true });
    delete process.env.CTR_DATASET_DIR;
  });

  afterEach(async () => {
    await pool.query("DELETE FROM interaction_events");
    await pool.query("DELETE FROM ctr_training_datasets");
    await pool.query("DELETE FROM task_state_history");
    await pool.query("DELETE FROM recommendation_candidates");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  it("writes a real JSONL file and registers matching ctr_training_datasets metadata", async () => {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type, accepted_agent_id)
       VALUES ($1, 'writing', 'Test Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'RELEASED', 'AUTOMATION', NULL)
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const taskId = task?.id ?? "";
    await pool.query(
      `INSERT INTO task_state_history (task_id, from_status, to_status, actor, occurred_at)
       VALUES ($1, 'SUBMITTED', 'RELEASED', 'system:test', '2026-09-01T00:00:00.000Z')`,
      [taskId],
    );
    const {
      rows: [agent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Test Agent', 'desc', 'writing', $1)
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const agentId = agent?.id ?? "";
    await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [agentId, taskId]);
    const {
      rows: [run],
    } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.1', 1, 'digest')
       RETURNING id`,
      [taskId],
    );
    const runId = run?.id ?? "";
    await pool.query(
      `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
       VALUES ($1, $2, 1, 'TOP_SCORE', 0.9, '[]')`,
      [runId, agentId],
    );
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, run_id, occurred_at)
       VALUES ('EXPOSURE', $1, $2, $3, $4, $5, '2026-09-01T00:00:00.000Z')`,
      [`server:${taskId}`, `exposure:${runId}:${agentId}`, taskId, agentId, runId],
    );

    const { snapshotVersion, outputPath, result } = await runBuild(pool, {
      asOf: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(result.matureExamples).toHaveLength(1);

    const fileContent = await readFile(outputPath, "utf8");
    const lines = fileContent.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as { taskId: string };
    expect(parsed.taskId).toBe(taskId);

    const { rows } = await pool.query<{
      feature_version: string;
      mature_example_count: number;
      immature_exposure_count: number;
      censored_candidate_count: number;
      output_path: string;
    }>(
      `SELECT feature_version, mature_example_count, immature_exposure_count, censored_candidate_count, output_path
       FROM ctr_training_datasets WHERE data_snapshot_version = $1`,
      [snapshotVersion],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature_version: FEATURE_VERSION,
      mature_example_count: 1,
      immature_exposure_count: 0,
      censored_candidate_count: 0,
      output_path: outputPath,
    });
  });

  it("F-1912/N4 P1 fix: automatically excludes an exposure whose session shows real click/view-farming volume, without the caller passing anything", async () => {
    const farmSessionId = `farm-session-${Math.random()}`;
    const normalSessionId = `normal-session-${Math.random()}`;

    const {
      rows: [farmTask],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type, accepted_agent_id)
       VALUES ($1, 'writing', 'Farm Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'RELEASED', 'AUTOMATION', NULL)
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const farmTaskId = farmTask?.id ?? "";
    await pool.query(
      `INSERT INTO task_state_history (task_id, from_status, to_status, actor, occurred_at)
       VALUES ($1, 'SUBMITTED', 'RELEASED', 'system:test', '2026-09-01T00:00:00.000Z')`,
      [farmTaskId],
    );
    const {
      rows: [farmAgent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Farm Agent', 'desc', 'writing', $1) RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const farmAgentId = farmAgent?.id ?? "";
    await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [
      farmAgentId,
      farmTaskId,
    ]);
    const {
      rows: [farmRun],
    } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.1', 1, 'digest') RETURNING id`,
      [farmTaskId],
    );
    const farmRunId = farmRun?.id ?? "";
    await pool.query(
      `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
       VALUES ($1, $2, 1, 'TOP_SCORE', 0.9, '[]')`,
      [farmRunId, farmAgentId],
    );
    // A real EXPOSURE row's session_id is ALWAYS the server-synthesized
    // `server:<taskId>` (T-1901's own convention) — never the client's own
    // session id. `farmSessionId` never appears on this row; the real
    // correlation to the farming client is via `run_id` (below).
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, run_id, occurred_at)
       VALUES ('EXPOSURE', $1, $2, $3, $4, $5, '2026-09-01T00:00:00.000Z')`,
      [
        `server:${farmTaskId}`,
        `exposure:${farmRunId}:${farmAgentId}`,
        farmTaskId,
        farmAgentId,
        farmRunId,
      ],
    );
    // 60 real client VIEW/CLICK events on the SAME (client) session,
    // reacting to the SAME run — over `detectAnomalousSessions`'s default
    // 50-event threshold. This `run_id` is the real correlation
    // `resolveAffectedRunIds` uses to bridge "this client session is
    // farming" to "these EXPOSURE rows must be excluded."
    for (let i = 0; i < 60; i += 1) {
      await pool.query(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, run_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-09-01T00:00:00.000Z')`,
        [
          i % 2 === 0 ? "VIEW" : "CLICK",
          farmSessionId,
          `client:farm-evt-${i}-${Math.random()}`,
          farmTaskId,
          farmAgentId,
          farmRunId,
        ],
      );
    }

    // A second, normal task/session — must still come through untouched.
    const {
      rows: [normalTask],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type, accepted_agent_id)
       VALUES ($1, 'writing', 'Normal Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'RELEASED', 'AUTOMATION', NULL)
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const normalTaskId = normalTask?.id ?? "";
    await pool.query(
      `INSERT INTO task_state_history (task_id, from_status, to_status, actor, occurred_at)
       VALUES ($1, 'SUBMITTED', 'RELEASED', 'system:test', '2026-09-01T00:00:00.000Z')`,
      [normalTaskId],
    );
    const {
      rows: [normalAgent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Normal Agent', 'desc', 'writing', $1) RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const normalAgentId = normalAgent?.id ?? "";
    await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [
      normalAgentId,
      normalTaskId,
    ]);
    const {
      rows: [normalRun],
    } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.1', 1, 'digest') RETURNING id`,
      [normalTaskId],
    );
    const normalRunId = normalRun?.id ?? "";
    await pool.query(
      `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
       VALUES ($1, $2, 1, 'TOP_SCORE', 0.9, '[]')`,
      [normalRunId, normalAgentId],
    );
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, run_id, occurred_at)
       VALUES ('EXPOSURE', $1, $2, $3, $4, $5, '2026-09-01T00:00:00.000Z')`,
      [
        normalSessionId,
        `exposure:${normalRunId}:${normalAgentId}`,
        normalTaskId,
        normalAgentId,
        normalRunId,
      ],
    );

    const { result, excludedSessionCount } = await runBuild(pool, {
      asOf: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(excludedSessionCount).toBe(1);
    expect(result.matureExamples.map((r) => r.taskId)).toEqual([normalTaskId]);
  });

  it("N4 P2 fix: deletes the just-written file when the ctr_training_datasets INSERT fails, leaving no orphan artifact", async () => {
    const before = await readdir(TEST_DATASET_DIR).catch(() => []);

    // A thin proxy over the real pool: every query runs for real EXCEPT
    // the one INSERT this script's own registration step issues, which is
    // forced to fail — proving the cleanup path without needing a real
    // migration/connection outage to reproduce it.
    const failingPool = {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO ctr_training_datasets")) {
          return Promise.reject(new Error("simulated registration failure"));
        }
        return pool.query(sql, params as never[]);
      },
    } as unknown as Pool;

    await expect(runBuild(failingPool)).rejects.toThrow("simulated registration failure");

    const after = await readdir(TEST_DATASET_DIR).catch(() => []);
    expect(after).toEqual(before);
  });
});
