import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import {
  advanceReleaseStage,
  checkAndAutoRollback,
  evaluateReleaseGate,
  getCurrentReleaseStage,
} from "./release-gate.js";
import { insertCtrModel, setActiveModel } from "./ctr-model-repository.js";
import { DEFAULT_FUSION_WEIGHTS, type FusionWeights } from "./fusion-weights.js";

/**
 * Real-Postgres integration test for T-1907's release-stage gate
 * (F-1910/F-1916, 用户 2026-09-06 Q-1902 决策). Covers all four numeric
 * gates against real data (real `shadow_ranking_results`/
 * `recommendation_runs` for the sample/agreement gates, real
 * `interaction_events` for the effect gate, real `dispatch_rerank_runs`
 * for the stability gate), the fail-closed readiness check, one-step-only
 * stage advancement with human approval, and automatic rollback.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

/** A fusion-weight vector that scores purely on `communication` — deliberately
 * different from Go's real `DEFAULT_FUSION_WEIGHTS` (which spreads weight
 * across all five signals, 0.30/0.30/0.15/0.20/0.05) so a task set whose
 * real reward is driven ONLY by `communication` lets this candidate rank
 * pairs correctly while Go's baseline gets them backwards — the same
 * "discoverable signal" technique `model-trainer.test.ts`/`train-ctr-
 * model.integration.test.ts` already establish, applied here via REAL
 * `interaction_events` rows (this gate reads the database directly, not
 * injected examples). */
const COMMUNICATION_ONLY_WEIGHTS: FusionWeights = {
  completionRate: 0,
  qualityFeedback: 0,
  communication: 1,
  disputeSignal: 0,
  historicalScale: 0,
};

function signalsFor(favored: boolean) {
  const entry = (value: number) => ({ value, sampleSize: 10 });
  return {
    completionRate: entry(favored ? 0 : 1),
    qualityFeedback: entry(0),
    communication: entry(favored ? 1 : 0),
    disputeSignal: entry(0),
    historicalScale: entry(0),
  };
}

runIfOptedIn("release-gate (integration, T-1907)", () => {
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
    await pool.query("DELETE FROM shadow_ranking_results");
    await pool.query("DELETE FROM dispatch_rerank_runs");
    await pool.query("DELETE FROM recommendation_candidates");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM ctr_models");
    await pool.query("DELETE FROM release_stage_audit_logs");
    await pool.query(`UPDATE release_stage_state SET stage = 'SHADOW' WHERE id = true`);
  });

  async function seedActiveModel(fusionWeights: FusionWeights): Promise<string> {
    const modelId = await insertCtrModel(pool, {
      modelVersion: `test-model-${Math.random()}`,
      dataSnapshotVersion: "snap-test",
      featureVersion: "v1",
      offlineMetrics: {},
      fusionWeights,
    });
    await setActiveModel(pool, modelId);
    return modelId;
  }

  async function seedTaskWithRun(): Promise<{ taskId: string; runId: string }> {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 100, $2, now() + interval '7 days', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const taskId = task?.id ?? "";
    const {
      rows: [run],
    } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.2', 1, 'digest') RETURNING id`,
      [taskId],
    );
    return { taskId, runId: run?.id ?? "" };
  }

  /** Seeds `count` real, DISTINCT-task shadow comparisons, all tagged with
   * `modelId`, backdated `daysAgo` days into `computed_at` (default: well
   * inside the trailing-30-day window). `agreementRate` controls what
   * fraction agree with Go's real top-1 pick. */
  async function seedDistinctShadowResults(
    modelId: string,
    count: number,
    agreementRate: number,
    options: { daysAgo?: number; latencyMs?: number } = {},
  ): Promise<void> {
    const daysAgo = options.daysAgo ?? 1;
    const latencyMs = options.latencyMs ?? 100;
    for (let i = 0; i < count; i += 1) {
      const { runId } = await seedTaskWithRun();
      const {
        rows: [rerankRun],
      } = await pool.query<{ id: string }>(
        `INSERT INTO dispatch_rerank_runs (run_id, stage, rerank_service_version, outcome, latency_ms, adopted, trace_id, created_at)
         VALUES ($1, 'SHADOW', 'test-version', 'SUCCESS', $2, false, $3, now() - ($4::int * interval '1 day'))
         RETURNING id`,
        [runId, latencyMs, `trace-${modelId}-${i}`, daysAgo],
      );
      const agrees = i < Math.round(count * agreementRate);
      const real = ["agent-a", "agent-b"];
      const shadow = agrees ? ["agent-a", "agent-b"] : ["agent-b", "agent-a"];
      await pool.query(
        `INSERT INTO shadow_ranking_results (run_id, rerank_run_id, ctr_model_id, shadow_ranked_agent_ids, real_ranked_agent_ids, computed_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6::int * interval '1 day'))`,
        [runId, rerankRun?.id, modelId, JSON.stringify(shadow), JSON.stringify(real), daysAgo],
      );
    }
  }

  /** Seeds `count` real, distinct tasks each with one accepted candidate
   * whose real reward (via a real RATE event) is driven entirely by
   * `communication` — Go's real baseline weights this signal poorly
   * relative to the (deliberately zeroed) `completionRate`, so this real
   * data lets `COMMUNICATION_ONLY_WEIGHTS` demonstrably out-rank Go's
   * fixed weights on real historical pairs. */
  async function seedRewardDrivenTasks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const {
        rows: [task],
      } = await pool.query<{ id: string }>(
        `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type, accepted_agent_id)
         VALUES ($1, 'writing', 'Task', 'desc', 100, $2, now() + interval '7 days', 'RELEASED', 'AUTOMATION', NULL)
         RETURNING id`,
        [REQUESTER_ADDRESS, TOKEN_ADDRESS],
      );
      const taskId = task?.id ?? "";
      const {
        rows: [agent],
      } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
        [REQUESTER_ADDRESS],
      );
      const agentId = agent?.id ?? "";
      await pool.query(`UPDATE tasks SET accepted_agent_id = $1 WHERE id = $2`, [agentId, taskId]);
      await pool.query(
        `INSERT INTO task_state_history (task_id, from_status, to_status, actor, occurred_at)
         VALUES ($1, 'SUBMITTED', 'RELEASED', 'system:test', now() - interval '1 day')`,
        [taskId],
      );
      const {
        rows: [run],
      } = await pool.query<{ id: string }>(
        `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
         VALUES ($1, 'v0.2', 1, 'digest') RETURNING id`,
        [taskId],
      );
      const runId = run?.id ?? "";
      const favored = i % 2 === 0;
      await pool.query(
        `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons, semantic_similarity, reputation_signals)
         VALUES ($1, $2, 1, 'TOP_SCORE', 0.9, '[]', 0.5, $3)`,
        [runId, agentId, JSON.stringify(signalsFor(favored))],
      );
      await pool.query(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, run_id, occurred_at)
         VALUES ('EXPOSURE', $1, $2, $3, $4, $5, now() - interval '2 days')`,
        [`server:${taskId}`, `exposure:${taskId}`, taskId, agentId, runId],
      );
      await pool.query(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, occurred_at)
         VALUES ('APPROVE', $1, $2, $3, $4, now() - interval '1 day')`,
        [`server:${taskId}`, `approve:${taskId}`, taskId, agentId],
      );
      await pool.query(
        `INSERT INTO ratings (task_id, requester_address, score) VALUES ($1, $2, $3)`,
        [taskId, REQUESTER_ADDRESS, favored ? 5 : 1],
      );
      await pool.query(
        `INSERT INTO interaction_events (event_type, session_id, client_event_id, task_id, agent_id, occurred_at)
         VALUES ('RATE', $1, $2, $3, $4, now() - interval '1 day')`,
        [`server:${taskId}`, `rate:${taskId}`, taskId, agentId],
      );
    }
  }

  async function seedStableRerankRuns(
    count: number,
    latencyMs: number,
    outcome: string,
  ): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const { runId } = await seedTaskWithRun();
      await pool.query(
        `INSERT INTO dispatch_rerank_runs (run_id, stage, rerank_service_version, outcome, latency_ms, adopted, trace_id)
         VALUES ($1, 'SHADOW', 'test-version', $2, $3, false, $4)`,
        [runId, outcome, latencyMs, `trace-stability-${i}`],
      );
    }
  }

  describe("evaluateReleaseGate", () => {
    it("readiness fails closed when there is no active ranking_policy_version", async () => {
      const gate = await evaluateReleaseGate(pool);
      expect(gate.readiness.ready).toBe(false);
      expect(gate.eligibleForAdvancement).toBe(false);
      expect(gate.blockedReasons).toHaveLength(1);
    });

    it("blocks on the sample-size gate when fewer than 200 distinct tasks have real shadow evidence in the window", async () => {
      const modelId = await seedActiveModel(DEFAULT_FUSION_WEIGHTS);
      await seedDistinctShadowResults(modelId, 5, 1);

      const gate = await evaluateReleaseGate(pool);
      expect(gate.readiness.ready).toBe(true);
      expect(gate.sampleGate?.distinctTaskCount).toBe(5);
      expect(gate.sampleGate?.sufficientSampleSize).toBe(false);
      expect(gate.eligibleForAdvancement).toBe(false);
    });

    it("N4-relevant regression guard: re-matching the SAME task many times within the window counts as ONE sample, not one per match", async () => {
      const modelId = await seedActiveModel(DEFAULT_FUSION_WEIGHTS);
      const { runId } = await seedTaskWithRun();
      for (let i = 0; i < 10; i += 1) {
        const {
          rows: [rerankRun],
        } = await pool.query<{ id: string }>(
          `INSERT INTO dispatch_rerank_runs (run_id, stage, rerank_service_version, outcome, latency_ms, adopted, trace_id)
           VALUES ($1, 'SHADOW', 'test-version', 'SUCCESS', 100, false, $2) RETURNING id`,
          [runId, `trace-dup-${i}`],
        );
        await pool.query(
          `INSERT INTO shadow_ranking_results (run_id, rerank_run_id, ctr_model_id, shadow_ranked_agent_ids, real_ranked_agent_ids)
           VALUES ($1, $2, $3, $4, $5)`,
          [runId, rerankRun?.id, modelId, JSON.stringify(["a", "b"]), JSON.stringify(["a", "b"])],
        );
      }

      const gate = await evaluateReleaseGate(pool);
      expect(gate.sampleGate?.distinctTaskCount).toBe(1);
    });

    it("excludes shadow evidence outside the 30-day window", async () => {
      const modelId = await seedActiveModel(DEFAULT_FUSION_WEIGHTS);
      await seedDistinctShadowResults(modelId, 5, 1, { daysAgo: 45 });

      const gate = await evaluateReleaseGate(pool);
      expect(gate.sampleGate?.distinctTaskCount).toBe(0);
    });

    it("blocks on the agreement-rate gate when real agreement is below 0.65, even with enough distinct-task samples", async () => {
      const modelId = await seedActiveModel(DEFAULT_FUSION_WEIGHTS);
      await seedDistinctShadowResults(modelId, 200, 0.4);

      const gate = await evaluateReleaseGate(pool);
      expect(gate.sampleGate?.sufficientSampleSize).toBe(true);
      expect(gate.agreementGate?.topOneAgreementRate).toBeCloseTo(0.4, 5);
      expect(gate.agreementGate?.meetsThreshold).toBe(false);
      expect(gate.eligibleForAdvancement).toBe(false);
    }, 30_000);

    it("blocks on the effect gate with 'insufficient linkage' when there is no real reward-labeled data in the window", async () => {
      const modelId = await seedActiveModel(DEFAULT_FUSION_WEIGHTS);
      await seedDistinctShadowResults(modelId, 200, 1);

      const gate = await evaluateReleaseGate(pool);
      expect(gate.effectGate?.sufficientData).toBe(false);
      expect(gate.eligibleForAdvancement).toBe(false);
    }, 30_000);

    it("blocks on the effect gate when the active model's weights are no better than Go's real baseline on fresh real data", async () => {
      // The active model IS Go's own baseline here — comparing it against
      // itself can never show an improvement, so `notRegressed` must be
      // exactly the boundary case (equal, not less) — real proof the
      // comparison is `>=`, not silently biased either direction.
      const modelId = await seedActiveModel(DEFAULT_FUSION_WEIGHTS);
      await seedDistinctShadowResults(modelId, 200, 1);
      await seedRewardDrivenTasks(40);
      await seedStableRerankRuns(10, 1000, "SUCCESS");

      const gate = await evaluateReleaseGate(pool);
      expect(gate.effectGate?.sufficientData).toBe(true);
      expect(gate.effectGate?.candidateConcordance).toBeCloseTo(
        gate.effectGate?.productionConcordance ?? -1,
        5,
      );
      expect(gate.effectGate?.notRegressed).toBe(true);
    }, 30_000);

    it("blocks on the stability gate when there is no real /rerank call data of any kind (readiness/sample gates block first — a real shadow comparison always implies a real rerank call, so 'no rerank data at all' and 'no shadow data' are the same real state)", async () => {
      await seedActiveModel(COMMUNICATION_ONLY_WEIGHTS);

      const gate = await evaluateReleaseGate(pool);
      expect(gate.stabilityGate?.hasData).toBe(false);
      expect(gate.eligibleForAdvancement).toBe(false);
    });

    it("blocks on the stability gate when P95 latency exceeds 8 seconds, even though every other gate is otherwise satisfied", async () => {
      const modelId = await seedActiveModel(COMMUNICATION_ONLY_WEIGHTS);
      // The 200 real shadow-evidence calls THEMSELVES are slow — a small
      // number of additional slow calls layered on top of 200 fast ones
      // would not move a real P95 at all, which is the whole point of
      // using a percentile rather than a mean.
      await seedDistinctShadowResults(modelId, 200, 1, { latencyMs: 12_000 });
      await seedRewardDrivenTasks(40);

      const gate = await evaluateReleaseGate(pool);
      expect(gate.stabilityGate?.hasData).toBe(true);
      expect(gate.stabilityGate?.p95LatencyMs).toBeGreaterThan(8_000);
      expect(gate.stabilityGate?.meetsLatencyThreshold).toBe(false);
      expect(gate.eligibleForAdvancement).toBe(false);
    }, 30_000);

    it("blocks on the stability gate when the error/timeout rate reaches 2%, even though every other gate is otherwise satisfied", async () => {
      const modelId = await seedActiveModel(COMMUNICATION_ONLY_WEIGHTS);
      await seedDistinctShadowResults(modelId, 200, 1);
      await seedRewardDrivenTasks(40);
      // 200 real SUCCESS calls already exist from the shadow seeding above
      // — enough real ERROR calls on top to genuinely push the combined
      // rate to/above 2%, not a number chosen to hit an exact decimal.
      await seedStableRerankRuns(20, 1000, "ERROR");

      const gate = await evaluateReleaseGate(pool);
      expect(gate.stabilityGate?.hasData).toBe(true);
      expect(gate.stabilityGate?.errorOrTimeoutRate).toBeGreaterThanOrEqual(0.02);
      expect(gate.stabilityGate?.meetsErrorRateThreshold).toBe(false);
      expect(gate.eligibleForAdvancement).toBe(false);
    }, 30_000);

    it("all four gates pass on real data that genuinely satisfies every threshold — the only fully-eligible scenario", async () => {
      const modelId = await seedActiveModel(COMMUNICATION_ONLY_WEIGHTS);
      await seedDistinctShadowResults(modelId, 200, 0.7);
      await seedRewardDrivenTasks(40);
      await seedStableRerankRuns(100, 1000, "SUCCESS");

      const gate = await evaluateReleaseGate(pool);
      expect(gate.readiness.ready).toBe(true);
      expect(gate.sampleGate?.sufficientSampleSize).toBe(true);
      expect(gate.agreementGate?.meetsThreshold).toBe(true);
      expect(gate.effectGate?.sufficientData).toBe(true);
      expect(gate.effectGate?.notRegressed).toBe(true);
      expect(gate.stabilityGate?.meetsLatencyThreshold).toBe(true);
      expect(gate.stabilityGate?.meetsErrorRateThreshold).toBe(true);
      expect(gate.eligibleForAdvancement).toBe(true);
      expect(gate.blockedReasons).toEqual([]);
    }, 30_000);
  });

  describe("advanceReleaseStage", () => {
    it("refuses to advance and leaves the stage unchanged when the gate is not eligible", async () => {
      const result = await advanceReleaseStage(pool, {
        approvedBy: "0xadmin0000000000000000000000000000000000",
        reason: "test attempt",
      });
      expect(result.advanced).toBe(false);
      expect(result.blockedReasons.length).toBeGreaterThan(0);
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("SHADOW");
      const { rows } = await pool.query(`SELECT * FROM release_stage_audit_logs`);
      expect(rows).toHaveLength(0);
    });

    it("advances exactly ONE stage (never skips) and records a human-approved audit row when the gate is eligible", async () => {
      const modelId = await seedActiveModel(COMMUNICATION_ONLY_WEIGHTS);
      await seedDistinctShadowResults(modelId, 200, 0.7);
      await seedRewardDrivenTasks(40);
      await seedStableRerankRuns(100, 1000, "SUCCESS");

      const result = await advanceReleaseStage(pool, {
        approvedBy: "0xadmin0000000000000000000000000000000000",
        reason: "满足全部门槛，批准进入 GRADUAL",
      });
      expect(result.advanced).toBe(true);
      expect(result.fromStage).toBe("SHADOW");
      expect(result.toStage).toBe("GRADUAL");
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("GRADUAL");

      const { rows } = await pool.query<{
        from_stage: string;
        to_stage: string;
        action: string;
        triggered_by: string;
      }>(`SELECT from_stage, to_stage, action, triggered_by FROM release_stage_audit_logs`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        from_stage: "SHADOW",
        to_stage: "GRADUAL",
        action: "ADVANCE",
        triggered_by: "human:0xadmin0000000000000000000000000000000000",
      });

      // Advancing again from GRADUAL, same real evidence still eligible,
      // goes to PRIMARY — never GRADUAL again, never back to SHADOW.
      const second = await advanceReleaseStage(pool, {
        approvedBy: "0xadmin0000000000000000000000000000000000",
        reason: "继续批准进入 PRIMARY",
      });
      expect(second.fromStage).toBe("GRADUAL");
      expect(second.toStage).toBe("PRIMARY");
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("PRIMARY");
    }, 30_000);

    it("refuses to advance past PRIMARY", async () => {
      await pool.query(`UPDATE release_stage_state SET stage = 'PRIMARY' WHERE id = true`);
      const result = await advanceReleaseStage(pool, {
        approvedBy: "0xadmin0000000000000000000000000000000000",
        reason: "test",
      });
      expect(result.advanced).toBe(false);
      expect(result.toStage).toBeNull();
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("PRIMARY");
    });

    it("N4-lesson race: two truly concurrent advance attempts against an ineligible gate never both succeed and never corrupt the audit log", async () => {
      const [first, second] = await Promise.all([
        advanceReleaseStage(pool, { approvedBy: "0xaaa", reason: "a" }),
        advanceReleaseStage(pool, { approvedBy: "0xbbb", reason: "b" }),
      ]);
      expect(first.advanced).toBe(false);
      expect(second.advanced).toBe(false);
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("SHADOW");
      const { rows } = await pool.query(`SELECT * FROM release_stage_audit_logs`);
      expect(rows).toHaveLength(0);
    });
  });

  describe("checkAndAutoRollback", () => {
    it("is a no-op when already in SHADOW", async () => {
      const result = await checkAndAutoRollback(pool);
      expect(result).toBeNull();
    });

    it("is a no-op (no audit row) when GRADUAL still passes a fresh gate re-check", async () => {
      const modelId = await seedActiveModel(COMMUNICATION_ONLY_WEIGHTS);
      await seedDistinctShadowResults(modelId, 200, 0.7);
      await seedRewardDrivenTasks(40);
      await seedStableRerankRuns(100, 1000, "SUCCESS");
      await pool.query(`UPDATE release_stage_state SET stage = 'GRADUAL' WHERE id = true`);

      const result = await checkAndAutoRollback(pool);
      expect(result).toBeNull();
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("GRADUAL");
      const { rows } = await pool.query(`SELECT * FROM release_stage_audit_logs`);
      expect(rows).toHaveLength(0);
    }, 30_000);

    it("automatically rolls GRADUAL back to SHADOW, with a system-triggered audit row, once the gate no longer passes", async () => {
      // GRADUAL with no supporting real evidence at all — the honest,
      // expected state today.
      await pool.query(`UPDATE release_stage_state SET stage = 'GRADUAL' WHERE id = true`);

      const result = await checkAndAutoRollback(pool);
      expect(result?.rolledBack).toBe(true);
      expect(result?.fromStage).toBe("GRADUAL");
      expect(result?.toStage).toBe("SHADOW");
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("SHADOW");

      const { rows } = await pool.query<{ action: string; triggered_by: string }>(
        `SELECT action, triggered_by FROM release_stage_audit_logs`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "ROLLBACK", triggered_by: "system:auto-rollback" });
    });

    it("automatically rolls PRIMARY all the way back to SHADOW (never a partial one-step rollback)", async () => {
      await pool.query(`UPDATE release_stage_state SET stage = 'PRIMARY' WHERE id = true`);

      const result = await checkAndAutoRollback(pool);
      expect(result?.fromStage).toBe("PRIMARY");
      expect(result?.toStage).toBe("SHADOW");
      await expect(getCurrentReleaseStage(pool)).resolves.toBe("SHADOW");
    });
  });
});
