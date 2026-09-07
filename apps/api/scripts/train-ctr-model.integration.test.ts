import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runPromote, runRollback, runTrain } from "./train-ctr-model.js";
import type { TrainingExampleRow } from "../src/modules/ctr-training/dataset-builder.js";
import type { ReputationSignalsDigest } from "../src/modules/dispatch/reputation-signals.js";
import {
  getActiveModel,
  getModelByVersion,
  insertCtrModel,
  setActiveModel,
} from "../src/modules/ctr-training/ctr-model-repository.js";

/**
 * Real-Postgres, real-filesystem integration test for T-1905's CLI script —
 * proves the actual orchestration (read dataset file → train → register
 * `ctr_models`; separately, `runPromote` re-validates against the CURRENT
 * production baseline and gates promotion on BOTH held-out offline
 * improvement and real per-candidate shadow-data sufficiency/quality → flip
 * `is_active`) against a real database, on top of `model-trainer.test.ts`'s
 * own unit coverage of the pure training/evaluation logic.
 *
 * Writes a synthetic JSONL dataset file directly (bypassing the real
 * `interaction_events` pipeline `dataset-builder.ts` reads from) — this
 * suite's job is proving THIS script's own read/train/register/promote
 * behavior, not re-proving `buildTrainingDataset`'s query logic (already
 * covered by `dataset-builder.integration.test.ts`).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const TEST_DATASET_DIR = path.resolve(process.cwd(), "var/train-ctr-model-test");
const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";

function entry(value: number | null): { value: number | null; sampleSize: number } {
  return { value, sampleSize: value === null ? 0 : 5 };
}

function signals(
  overrides: Partial<Record<keyof ReputationSignalsDigest, number>>,
): ReputationSignalsDigest {
  return {
    completionRate: entry(overrides.completionRate ?? null),
    qualityFeedback: entry(overrides.qualityFeedback ?? null),
    communication: entry(overrides.communication ?? null),
    disputeSignal: entry(overrides.disputeSignal ?? null),
    historicalScale: entry(overrides.historicalScale ?? null),
  };
}

/** An ACCEPTED candidate (`model-trainer.ts` only ever uses accepted, i.e.
 * genuinely un-censored, candidates — see its own N4 doc comment) whose
 * reward is driven by `ratingScore`. */
function acceptedExample(
  taskId: string,
  reputationSignals: ReputationSignalsDigest,
  ratingScore: number,
): TrainingExampleRow {
  return {
    exposureEventId: `exp-${taskId}`,
    taskId,
    agentId: `agent-${taskId}`,
    runId: `run-${taskId}`,
    algorithmVersion: "v0.2",
    taskTerminalStatus: "RELEASED",
    candidateFeatures: {
      score: 0.5,
      rank: 1,
      slotType: "TOP_SCORE",
      reputationSignals,
      semanticSimilarity: null,
    },
    wasAccepted: true,
    outcome: { approved: true, ratingScore, refunded: false, disputed: false },
  };
}

async function registerDataset(
  pool: Pool,
  snapshotVersion: string,
  examples: TrainingExampleRow[],
): Promise<void> {
  await mkdir(TEST_DATASET_DIR, { recursive: true });
  const outputPath = path.join(TEST_DATASET_DIR, `${snapshotVersion}.jsonl`);
  await writeFile(outputPath, examples.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await pool.query(
    `INSERT INTO ctr_training_datasets
       (data_snapshot_version, feature_version, as_of, mature_example_count, immature_exposure_count, censored_candidate_count, output_path)
     VALUES ($1, 'v1', now(), $2, 0, 0, $3)`,
    [snapshotVersion, examples.length, outputPath],
  );
}

/** 90 tasks, each with exactly ONE accepted candidate whose reward (via
 * `ratingScore`) is driven by `favoredSignal`, not `disfavoredSignal` — the
 * reverse of Go's default weighting when `favoredSignal`/`disfavoredSignal`
 * are `communication`/`completionRate` (0.15 < 0.30) — so a training run
 * should find a weight vector that separates them on the held-out
 * validation split. 90 (not fewer) because `splitByTask` sends ~1/3 to
 * validation and the promotion decision is measured on validation alone —
 * same reasoning as `model-trainer.test.ts`'s own "discoverable signal"
 * case. */
function buildLearnableExamples(
  favoredSignal: keyof ReputationSignalsDigest = "communication",
  disfavoredSignal: keyof ReputationSignalsDigest = "completionRate",
  taskPrefix = "task",
): TrainingExampleRow[] {
  const examples: TrainingExampleRow[] = [];
  for (let i = 0; i < 90; i += 1) {
    const taskId = `${taskPrefix}-${i}`;
    const favoredValue = i % 2 === 0 ? 1 : 0;
    const ratingScore = favoredValue === 1 ? 5 : 1;
    examples.push(
      acceptedExample(
        taskId,
        signals({ [disfavoredSignal]: 1 - favoredValue, [favoredSignal]: favoredValue }),
        ratingScore,
      ),
    );
  }
  return examples;
}

/** Seeds `count` real `shadow_ranking_results` rows tagged with `ctrModelId`
 * — the minimum real FK chain that table requires (a `recommendation_runs`
 * row and a `dispatch_rerank_runs` row per shadow row). `agreementRate`
 * controls what fraction agree with Go's real top-1 pick, letting tests
 * exercise both the sample-count gate and the agreement-quality gate. */
async function seedShadowResults(
  pool: Pool,
  ctrModelId: string,
  count: number,
  agreementRate: number,
): Promise<void> {
  await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
    REQUESTER_ADDRESS,
  ]);
  const {
    rows: [task],
  } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
     VALUES ($1, 'writing', 'Task', 'desc', 100, '0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7', now() + interval '7 days', 'OPEN', 'AUTOMATION')
     RETURNING id`,
    [REQUESTER_ADDRESS],
  );
  const taskId = task?.id ?? "";
  const {
    rows: [run],
  } = await pool.query<{ id: string }>(
    `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
     VALUES ($1, 'v0.2', 1, 'digest') RETURNING id`,
    [taskId],
  );
  const runId = run?.id ?? "";

  for (let i = 0; i < count; i += 1) {
    const {
      rows: [rerankRun],
    } = await pool.query<{ id: string }>(
      `INSERT INTO dispatch_rerank_runs (run_id, stage, rerank_service_version, outcome, latency_ms, adopted, trace_id)
       VALUES ($1, 'SHADOW', 'test-version', 'SUCCESS', 100, false, $2) RETURNING id`,
      [runId, `trace-${ctrModelId}-${i}`],
    );
    const agrees = i < Math.round(count * agreementRate);
    const real = ["agent-a", "agent-b"];
    const shadow = agrees ? ["agent-a", "agent-b"] : ["agent-b", "agent-a"];
    await pool.query(
      `INSERT INTO shadow_ranking_results (run_id, rerank_run_id, ctr_model_id, shadow_ranked_agent_ids, real_ranked_agent_ids)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, rerankRun?.id, ctrModelId, JSON.stringify(shadow), JSON.stringify(real)],
    );
  }
}

runIfOptedIn("train-ctr-model script (integration, T-1905)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
    await rm(TEST_DATASET_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM shadow_ranking_results");
    await pool.query("DELETE FROM dispatch_rerank_runs");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM ctr_models");
    await pool.query("DELETE FROM ctr_training_datasets");
  });

  it("runTrain registers a ctr_models row and never promotes it", async () => {
    await registerDataset(pool, "snap-basic", buildLearnableExamples());

    const result = await runTrain(pool, "snap-basic");

    const model = await getModelByVersion(pool, result.modelVersion);
    expect(model).not.toBeNull();
    expect(model?.isActive).toBe(false);
    expect(model?.dataSnapshotVersion).toBe("snap-basic");
  });

  it("AC-1913 rejection path: blocks promotion when offline sample size is insufficient, and no version becomes active", async () => {
    await registerDataset(pool, "snap-tiny", [
      acceptedExample("task-a", signals({ completionRate: 1 }), 5),
      acceptedExample("task-b", signals({ completionRate: 0 }), 1),
    ]);
    const { modelVersion } = await runTrain(pool, "snap-tiny");

    const result = await runPromote(pool, modelVersion);

    expect(result.promoted).toBe(false);
    expect(result.promotionBlockedReason).toContain("样本量不足");
    expect(await getActiveModel(pool)).toBeNull();
  });

  it("AC-1913 rejection path: blocks promotion when offline metrics don't improve on production, even with a large sample", async () => {
    // Every accepted candidate has an IDENTICAL signal and IDENTICAL
    // reward, so no weight vector can ever distinguish any pair — every
    // pair is a coin flip regardless of weights (candidate concordance can
    // never strictly exceed production's).
    const examples: TrainingExampleRow[] = [];
    for (let i = 0; i < 90; i += 1) {
      examples.push(acceptedExample(`task-tied-${i}`, signals({ completionRate: 0.5 }), 3));
    }
    await registerDataset(pool, "snap-no-improvement", examples);
    const { modelVersion, training } = await runTrain(pool, "snap-no-improvement");
    expect(training.usableExampleCount).toBe(90);

    const result = await runPromote(pool, modelVersion);

    expect(result.promoted).toBe(false);
    expect(result.promotionBlockedReason).toMatch(/样本量不足|未优于当前生产版本/);
    expect(await getActiveModel(pool)).toBeNull();
  });

  it("AC-1913 rejection path: blocks promotion when offline metrics improve but real shadow data is insufficient", async () => {
    await registerDataset(pool, "snap-learnable", buildLearnableExamples());
    const { modelVersion, training } = await runTrain(pool, "snap-learnable");
    expect(training.sufficientData).toBe(true);
    expect(training.improvedOverProduction).toBe(true);

    const result = await runPromote(pool, modelVersion);

    expect(result.revalidation.sufficientData).toBe(true);
    expect(result.revalidation.improvedOverProduction).toBe(true);
    expect(result.shadow.sufficientData).toBe(false); // no real shadow_ranking_results rows exist
    expect(result.promoted).toBe(false);
    expect(result.promotionBlockedReason).toContain("影子对比真实样本量不足");
    expect(await getActiveModel(pool)).toBeNull();
  });

  it("N4 P1 fix: blocks promotion when real shadow data exists but disagrees with Go's real ranking too often", async () => {
    await registerDataset(pool, "snap-learnable-2", buildLearnableExamples());
    const { modelVersion } = await runTrain(pool, "snap-learnable-2");
    const model = await getModelByVersion(pool, modelVersion);

    // 30 real shadow rows tagged with THIS candidate's id, but only 20% agree
    // with Go's real top-1 pick — below the safety threshold.
    await seedShadowResults(pool, model?.id ?? "", 30, 0.2);

    const result = await runPromote(pool, modelVersion);

    expect(result.shadow.sufficientData).toBe(true);
    expect(result.shadow.meetsAgreementThreshold).toBe(false);
    expect(result.promoted).toBe(false);
    expect(result.promotionBlockedReason).toContain("一致性过低");
    expect(await getActiveModel(pool)).toBeNull();
  });

  it("N4 P1 fix: shadow data tagged with an UNRELATED ctr_model_id does not count toward this candidate's gate", async () => {
    await registerDataset(pool, "snap-learnable-3", buildLearnableExamples());
    const { modelVersion } = await runTrain(pool, "snap-learnable-3");

    // 30 real, high-agreement shadow rows exist, but tagged with a
    // different (unrelated) model id — must not leak into this candidate's
    // own evaluation.
    const unrelatedModelId = await insertCtrModel(pool, {
      modelVersion: "unrelated-model",
      dataSnapshotVersion: "snap-learnable-3",
      featureVersion: "v1",
      offlineMetrics: {},
      fusionWeights: {
        completionRate: 0.3,
        qualityFeedback: 0.3,
        communication: 0.15,
        disputeSignal: 0.2,
        historicalScale: 0.05,
      },
    });
    await seedShadowResults(pool, unrelatedModelId, 30, 1);

    const result = await runPromote(pool, modelVersion);

    expect(result.shadow.sampleCount).toBe(0);
    expect(result.shadow.sufficientData).toBe(false);
    expect(result.promoted).toBe(false);
  });

  it("N4 P1 fix: re-validates against the CURRENT production baseline, not the possibly-stale baseline recorded at train time", async () => {
    await registerDataset(pool, "snap-promote-stale", buildLearnableExamples());
    const trained = await runTrain(pool, "snap-promote-stale");
    expect(trained.training.improvedOverProduction).toBe(true);

    // Simulate a DIFFERENT, newer version becoming production AFTER this
    // candidate was trained but BEFORE it is promoted — exactly this
    // candidate's own weights, so it can no longer show improvement over
    // "current production" even though its stored (train-time) metrics
    // still say `improvedOverProduction: true`.
    const newerProductionId = await insertCtrModel(pool, {
      modelVersion: "newer-production",
      dataSnapshotVersion: "snap-promote-stale",
      featureVersion: "v1",
      offlineMetrics: {},
      fusionWeights: trained.training.candidateWeights,
    });
    await setActiveModel(pool, newerProductionId);

    const model = await getModelByVersion(pool, trained.modelVersion);
    await seedShadowResults(pool, model?.id ?? "", 30, 1);

    const result = await runPromote(pool, trained.modelVersion);

    expect(result.revalidation.improvedOverProduction).toBe(false);
    expect(result.promoted).toBe(false);
    expect(result.promotionBlockedReason).toContain("未优于当前生产版本");
    // The newer production version must remain active — untouched.
    expect((await getActiveModel(pool))?.modelVersion).toBe("newer-production");
  });

  it("AC-1913 happy path + rollback: promotes when both gates pass, and a rollback restores the previous version", async () => {
    await registerDataset(pool, "snap-promote", buildLearnableExamples());
    const first = await runTrain(pool, "snap-promote");
    const firstModel = await getModelByVersion(pool, first.modelVersion);
    await seedShadowResults(pool, firstModel?.id ?? "", 30, 1);

    const firstPromotion = await runPromote(pool, first.modelVersion);

    expect(firstPromotion.promoted).toBe(true);
    expect(firstPromotion.promotionBlockedReason).toBeNull();
    const activeAfterFirst = await getActiveModel(pool);
    expect(activeAfterFirst?.modelVersion).toBe(first.modelVersion);

    // A second promotion should deactivate the first (`ctr_models_single_
    // active_idx`, migration 0033, would reject two simultaneously-active
    // rows) — exercised directly against `setActiveModel` (the same
    // function `runPromote`'s own promotion path calls) rather than a full
    // second training/promotion cycle, since a second run trained on the
    // identical learnable pattern would inherit the first run's already-
    // optimal weights as ITS OWN production baseline and correctly find
    // nothing left to improve (a real property of the algorithm, already
    // covered by `model-trainer.test.ts`'s own "no improvement found" and
    // "stale baseline" cases; this test's job is proving the promotion/
    // rollback POINTER mechanics).
    const secondModelId = await insertCtrModel(pool, {
      modelVersion: "manual-second-version",
      dataSnapshotVersion: "snap-promote",
      featureVersion: "v1",
      offlineMetrics: { note: "manually registered for rollback test" },
      fusionWeights: first.training.candidateWeights,
    });
    await setActiveModel(pool, secondModelId);
    const activeAfterSecond = await getActiveModel(pool);
    expect(activeAfterSecond?.modelVersion).toBe("manual-second-version");

    const firstModelAfterSecond = await getModelByVersion(pool, first.modelVersion);
    expect(firstModelAfterSecond?.isActive).toBe(false);

    // design.md 决策 6: "回滚是指针切换，不需要重新训练".
    await runRollback(pool, first.modelVersion);
    expect((await getActiveModel(pool))?.modelVersion).toBe(first.modelVersion);
    expect((await getModelByVersion(pool, "manual-second-version"))?.isActive).toBe(false);
  });
});
