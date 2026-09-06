import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildTrainingDataset } from "./dataset-builder.js";

/**
 * Real-Postgres integration test for T-1904's `buildTrainingDataset`
 * (F-1906/AC-1904 前半). Skipped unless a human opts in with
 * RUN_DB_INTEGRATION_TESTS=1, same as every other `*.integration.test.ts`
 * suite.
 *
 * Covers: a mature, accepted candidate's real outcome events are correctly
 * attributed and reflected in `outcome`; a mature, NOT-accepted candidate
 * (the same run's other exposed-but-unselected agent) is exported as a
 * censored row with `outcome: null`, not silently dropped (F-1906's
 * exposure-censoring requirement); an exposure whose task hasn't reached a
 * terminal status is excluded and counted in `immatureExposureCount`
 * (delayed-feedback handling); a `v0.1` exposure's persisted-null
 * reputation signals/semantic similarity come through as `null`, never
 * backfilled (T-1903's own hard rule); two calls with the same `asOf`
 * against unchanged data produce byte-identical results (AC-1904's
 * reproducibility requirement).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";

runIfOptedIn("buildTrainingDataset (integration, T-1904)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM interaction_events");
    await pool.query("DELETE FROM ratings");
    await pool.query("DELETE FROM task_state_history");
    await pool.query("DELETE FROM recommendation_candidates");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  const TERMINAL_STATUSES = new Set(["RELEASED", "REFUNDED", "CANCELLED"]);

  /** `terminalTransitionAt` defaults to well before every test's own
   * `asOf` (2026-09-01, vs the tests' typical 2026-09-03) — the dataset
   * builder now determines maturity from a real `task_state_history` row,
   * not `tasks.status`'s current value (N4 P1 fix), so every seeded
   * terminal-status task needs a matching transition row for the existing
   * "this task is mature" test scenarios to still mean what they say. */
  async function seedTask(
    status: string,
    terminalTransitionAt = "2026-09-01T00:00:00.000Z",
  ): Promise<string> {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Test Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', $2, 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, status],
    );
    const taskId = task?.id ?? "";
    if (TERMINAL_STATUSES.has(status)) {
      await pool.query(
        `INSERT INTO task_state_history (task_id, from_status, to_status, actor, occurred_at)
         VALUES ($1, 'SUBMITTED', $2, 'system:test', $3)`,
        [taskId, status, terminalTransitionAt],
      );
    }
    return taskId;
  }

  async function seedAgent(): Promise<string> {
    const {
      rows: [agent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Test Agent', 'desc', 'writing', $1)
       RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    return agent?.id ?? "";
  }

  async function seedRun(taskId: string, algorithmVersion: string): Promise<string> {
    const {
      rows: [run],
    } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, $2, 1, 'digest')
       RETURNING id`,
      [taskId, algorithmVersion],
    );
    return run?.id ?? "";
  }

  async function seedCandidate(
    runId: string,
    agentId: string,
    rank: number,
    reputationSignals: unknown,
    semanticSimilarity: number | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons, semantic_similarity, reputation_signals)
       VALUES ($1, $2, $3, 'TOP_SCORE', 0.9, '[]', $4, $5)`,
      [
        runId,
        agentId,
        rank,
        semanticSimilarity,
        reputationSignals ? JSON.stringify(reputationSignals) : null,
      ],
    );
  }

  async function seedExposure(
    taskId: string,
    agentId: string,
    runId: string,
    occurredAt: string,
    sessionId = `server:${taskId}`,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, run_id, occurred_at)
       VALUES ('EXPOSURE', $1, $2, $3, $4, $5, $6)`,
      [sessionId, `exposure:${runId}:${agentId}`, taskId, agentId, runId, occurredAt],
    );
  }

  const SIGNALS = {
    completionRate: { value: 0.9, sampleSize: 10 },
    qualityFeedback: { value: 0.8, sampleSize: 10 },
    communication: { value: 0.85, sampleSize: 10 },
    disputeSignal: { value: 0.95, sampleSize: 10 },
    historicalScale: { value: 0.5, sampleSize: 10 },
  };

  it("exports the accepted candidate with its real attributed outcome, and the non-accepted candidate as a censored row with outcome: null", async () => {
    const taskId = await seedTask("RELEASED");
    const acceptedAgentId = await seedAgent();
    const otherAgentId = await seedAgent();
    await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [
      acceptedAgentId,
      taskId,
    ]);
    const runId = await seedRun(taskId, "v0.2");
    await seedCandidate(runId, acceptedAgentId, 1, SIGNALS, 0.7);
    await seedCandidate(runId, otherAgentId, 2, SIGNALS, 0.5);

    await seedExposure(taskId, acceptedAgentId, runId, "2026-09-01T00:00:00.000Z");
    await seedExposure(taskId, otherAgentId, runId, "2026-09-01T00:00:00.000Z");
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, occurred_at)
       VALUES ('APPROVE', $1, $2, $3, $4, $5)`,
      [
        `server:${taskId}`,
        `approve:${taskId}`,
        taskId,
        acceptedAgentId,
        "2026-09-02T00:00:00.000Z",
      ],
    );
    await pool.query(`INSERT INTO ratings (task_id, requester_address, score) VALUES ($1, $2, 5)`, [
      taskId,
      REQUESTER_ADDRESS,
    ]);
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, occurred_at)
       VALUES ('RATE', $1, $2, $3, $4, $5)`,
      [`server:${taskId}`, `rate:${taskId}`, taskId, acceptedAgentId, "2026-09-02T00:01:00.000Z"],
    );

    const result = await buildTrainingDataset(pool, { asOf: new Date("2026-09-03T00:00:00.000Z") });
    expect(result.immatureExposureCount).toBe(0);
    expect(result.matureExamples).toHaveLength(2);

    const accepted = result.matureExamples.find((r) => r.agentId === acceptedAgentId);
    expect(accepted?.wasAccepted).toBe(true);
    expect(accepted?.outcome).toEqual({
      approved: true,
      ratingScore: 5,
      refunded: false,
      disputed: false,
    });
    expect(accepted?.candidateFeatures.reputationSignals).toEqual(SIGNALS);
    expect(accepted?.candidateFeatures.semanticSimilarity).toBe(0.7);

    const censored = result.matureExamples.find((r) => r.agentId === otherAgentId);
    expect(censored?.wasAccepted).toBe(false);
    expect(censored?.outcome).toBeNull();
  });

  it("F-1906: excludes an exposure whose task hasn't reached a terminal status, counting it as immature", async () => {
    const taskId = await seedTask("SUBMITTED");
    const agentId = await seedAgent();
    const runId = await seedRun(taskId, "v0.2");
    await seedCandidate(runId, agentId, 1, SIGNALS, 0.7);
    await seedExposure(taskId, agentId, runId, "2026-09-01T00:00:00.000Z");

    const result = await buildTrainingDataset(pool, { asOf: new Date("2026-09-03T00:00:00.000Z") });
    expect(result.matureExamples).toHaveLength(0);
    expect(result.immatureExposureCount).toBe(1);
  });

  it("T-1903 rule: a v0.1 exposure's null persisted reputation signals/semantic similarity come through as null, never backfilled", async () => {
    const taskId = await seedTask("CANCELLED");
    const agentId = await seedAgent();
    const runId = await seedRun(taskId, "v0.1");
    await seedCandidate(runId, agentId, 1, null, null);
    await seedExposure(taskId, agentId, runId, "2026-09-01T00:00:00.000Z");

    const result = await buildTrainingDataset(pool, { asOf: new Date("2026-09-03T00:00:00.000Z") });
    expect(result.matureExamples).toHaveLength(1);
    expect(result.matureExamples[0]?.candidateFeatures.reputationSignals).toBeNull();
    expect(result.matureExamples[0]?.candidateFeatures.semanticSimilarity).toBeNull();
    // CANCELLED never has an accepted_agent_id (T-1901's own REFUND-B
    // reasoning) — a cancellation-path exposure is therefore always
    // wasAccepted: false, a censored row.
    expect(result.matureExamples[0]?.wasAccepted).toBe(false);
  });

  it("N4 P1 fix: a task that only reaches a terminal status AFTER asOf is treated as immature, even though its CURRENT status is already terminal", async () => {
    // Terminal transition happens on 2026-09-10 — after the 2026-09-03
    // asOf every other test in this file uses.
    const taskId = await seedTask("RELEASED", "2026-09-10T00:00:00.000Z");
    const agentId = await seedAgent();
    await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [agentId, taskId]);
    const runId = await seedRun(taskId, "v0.2");
    await seedCandidate(runId, agentId, 1, SIGNALS, 0.7);
    await seedExposure(taskId, agentId, runId, "2026-09-01T00:00:00.000Z");

    const result = await buildTrainingDataset(pool, { asOf: new Date("2026-09-03T00:00:00.000Z") });
    expect(result.matureExamples).toHaveLength(0);
    expect(result.immatureExposureCount).toBe(1);

    // Rebuilding the SAME asOf snapshot after the task actually settles
    // must produce the SAME result — a real historical snapshot must not
    // change just because time has moved on (AC-1904's reproducibility
    // requirement, and the whole point of this fix).
    const rebuilt = await buildTrainingDataset(pool, {
      asOf: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(rebuilt.matureExamples).toHaveLength(0);
    expect(rebuilt.immatureExposureCount).toBe(1);
  });

  it("N4 P1 fix: an APPROVE/RATE event that happened AFTER asOf is excluded from the outcome, even though it's within the attribution window", async () => {
    const taskId = await seedTask("RELEASED", "2026-09-01T12:00:00.000Z");
    const agentId = await seedAgent();
    await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [agentId, taskId]);
    const runId = await seedRun(taskId, "v0.2");
    await seedCandidate(runId, agentId, 1, SIGNALS, 0.7);
    await seedExposure(taskId, agentId, runId, "2026-09-01T00:00:00.000Z");
    // Approved on 2026-09-04 — after the 2026-09-03 asOf below, but still
    // well within the 7-day attribution window from the exposure.
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, occurred_at)
       VALUES ('APPROVE', $1, $2, $3, $4, $5)`,
      [`server:${taskId}`, `approve:${taskId}`, taskId, agentId, "2026-09-04T00:00:00.000Z"],
    );

    const result = await buildTrainingDataset(pool, { asOf: new Date("2026-09-03T00:00:00.000Z") });
    expect(result.matureExamples).toHaveLength(1);
    expect(result.matureExamples[0]?.outcome).toEqual({
      approved: false,
      ratingScore: null,
      refunded: false,
      disputed: false,
    });
  });

  it("N4 P2 fix (round 2): two exposures sharing the exact same occurred_at still produce a deterministic (identical) row order across repeated calls", async () => {
    const taskId = await seedTask("RELEASED");
    const agentA = await seedAgent();
    const agentB = await seedAgent();
    await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [agentA, taskId]);
    const runId = await seedRun(taskId, "v0.2");
    await seedCandidate(runId, agentA, 1, SIGNALS, 0.7);
    await seedCandidate(runId, agentB, 2, SIGNALS, 0.5);
    // Identical occurred_at — exactly the tied-timestamp scenario a
    // single transactional relay batch produces in practice.
    const sameInstant = "2026-09-01T00:00:00.000Z";
    await seedExposure(taskId, agentA, runId, sameInstant);
    await seedExposure(taskId, agentB, runId, sameInstant);

    const asOf = new Date("2026-09-03T00:00:00.000Z");
    const first = await buildTrainingDataset(pool, { asOf });
    const second = await buildTrainingDataset(pool, { asOf });
    expect(first.matureExamples.map((r) => r.agentId)).toEqual(
      second.matureExamples.map((r) => r.agentId),
    );
  });

  it("AC-1904: two calls with the same asOf against unchanged data produce identical results", async () => {
    const taskId = await seedTask("REFUNDED");
    const agentId = await seedAgent();
    const runId = await seedRun(taskId, "v0.2");
    await seedCandidate(runId, agentId, 1, SIGNALS, 0.6);
    await seedExposure(taskId, agentId, runId, "2026-09-01T00:00:00.000Z");

    const asOf = new Date("2026-09-03T00:00:00.000Z");
    const first = await buildTrainingDataset(pool, { asOf });
    const second = await buildTrainingDataset(pool, { asOf });
    expect(JSON.stringify(first.matureExamples)).toBe(JSON.stringify(second.matureExamples));
    expect(first.immatureExposureCount).toBe(second.immatureExposureCount);
  });

  it("F-1912: excludes an exposure whose run_id is in excludedRunIds, while an unrelated run's exposure still comes through", async () => {
    const taskA = await seedTask("RELEASED");
    const agentA = await seedAgent();
    const runA = await seedRun(taskA, "v0.2");
    await seedCandidate(runA, agentA, 1, SIGNALS, 0.6);
    await seedExposure(taskA, agentA, runA, "2026-09-01T00:00:00.000Z");

    const taskB = await seedTask("RELEASED");
    const agentB = await seedAgent();
    const runB = await seedRun(taskB, "v0.2");
    await seedCandidate(runB, agentB, 1, SIGNALS, 0.6);
    await seedExposure(taskB, agentB, runB, "2026-09-01T00:00:00.000Z");

    const asOf = new Date("2026-09-03T00:00:00.000Z");
    const result = await buildTrainingDataset(pool, {
      asOf,
      excludedRunIds: [runA],
    });

    expect(result.matureExamples.map((r) => r.taskId)).toEqual([taskB]);
  });
});
