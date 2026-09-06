// Feature 19 (ctr-online-learning), T-1905 (F-1907/F-1908/F-1922, design.md
// 决策 6).
//
// Standalone CLI script (same "训练脚本：独立命令行工具" convention as
// T-1904's `build-ctr-training-dataset.ts`) — thin shell around
// `model-trainer.ts`'s `trainModel` (the actual, independently testable
// logic).
//
// N4 real finding (P1, round 1): the original single-invocation
// train-then-promote flow evaluated `shadow_ranking_results` for a
// candidate model that had not been registered yet — meaning the shadow
// query couldn't possibly filter to THIS candidate's own real shadow
// evidence (`ctr_model_id` doesn't exist until the row does). Fixed by
// splitting into two genuinely separate operations, matching the real
// operational timeline design.md itself describes ("训练 → 产出版本 →
// [真实影子流量随时间积累] → 影子对比确认 → 人工批准 → 晋升"): `runTrain`
// only registers a candidate (real offline evaluation, no promotion
// decision — the audit trail AC-1913 requires even for a later-rejected
// attempt); `runPromote` is a SEPARATE, later invocation against an
// ALREADY-registered candidate, evaluating its real accumulated shadow
// evidence (which can only exist after the candidate itself exists) before
// deciding.
//
// N4 real finding (P1, round 2): `runPromote` used to trust the
// `improvedOverProduction` flag `runTrain` computed and stored at TRAIN
// time — but promotion can happen much later, after a DIFFERENT candidate
// has since become the active production version. Comparing against a
// stale baseline could let a candidate worse than the CURRENT production
// version still get promoted. Fixed: `runPromote` re-loads the candidate's
// original training examples and re-evaluates it against WHATEVER is
// active right now, immediately before deciding.
//
// Run as:
//   pnpm --filter @agent-market/api train-ctr-model -- --dataset <snapshotVersion>
//   pnpm --filter @agent-market/api train-ctr-model -- --promote <modelVersion>
//   pnpm --filter @agent-market/api train-ctr-model -- --rollback-to <modelVersion>
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import type { TrainingExampleRow } from "../src/modules/ctr-training/dataset-builder.js";
import {
  evaluateStoredCandidateAgainstCurrentProduction,
  trainModel,
  type EvaluationResult,
  type TrainModelResult,
} from "../src/modules/ctr-training/model-trainer.js";
import { evaluateAgainstShadowData } from "../src/modules/ctr-training/shadow-comparison.js";
import {
  getActiveModel,
  getModelByVersion,
  insertCtrModel,
  setActiveModel,
} from "../src/modules/ctr-training/ctr-model-repository.js";
import { DEFAULT_FUSION_WEIGHTS } from "../src/modules/ctr-training/fusion-weights.js";

function generateModelVersion(): string {
  return `fusion-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
}

async function loadDataset(
  pool: Pool,
  snapshotVersion: string,
): Promise<{ examples: TrainingExampleRow[]; featureVersion: string }> {
  const { rows } = await pool.query<{ feature_version: string; output_path: string }>(
    `SELECT feature_version, output_path FROM ctr_training_datasets WHERE data_snapshot_version = $1`,
    [snapshotVersion],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `train-ctr-model: no ctr_training_datasets row for snapshot ${snapshotVersion}`,
    );
  }
  const raw = await readFile(row.output_path, "utf8");
  const examples = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TrainingExampleRow);
  return { examples, featureVersion: row.feature_version };
}

export interface RunTrainResult {
  modelVersion: string;
  training: TrainModelResult;
}

/** Registers a new candidate `ctr_models` row — never promotes it. Every
 * invocation records the attempt (AC-1913's own "模拟离线评估不达标...验证
 * 晋升被阻止且原版本继续生效" requires a rejected attempt to still be a
 * real, inspectable record, not silently discarded). */
export async function runTrain(
  pool: Pool,
  datasetSnapshotVersion: string,
): Promise<RunTrainResult> {
  const { examples, featureVersion } = await loadDataset(pool, datasetSnapshotVersion);

  const activeModel = await getActiveModel(pool);
  const productionWeights = activeModel?.fusionWeights ?? DEFAULT_FUSION_WEIGHTS;

  const training = trainModel(examples, { productionWeights });

  const modelVersion = generateModelVersion();
  await insertCtrModel(pool, {
    modelVersion,
    dataSnapshotVersion: datasetSnapshotVersion,
    featureVersion,
    offlineMetrics: {
      pairCount: training.pairCount,
      usableExampleCount: training.usableExampleCount,
      sufficientData: training.sufficientData,
      candidateConcordance: training.candidateConcordance,
      productionConcordance: training.productionConcordance,
      improvedOverProduction: training.improvedOverProduction,
    },
    fusionWeights: training.candidateWeights,
  });

  return { modelVersion, training };
}

export interface RunPromoteResult {
  revalidation: EvaluationResult;
  shadow: Awaited<ReturnType<typeof evaluateAgainstShadowData>>;
  promoted: boolean;
  promotionBlockedReason: string | null;
}

/**
 * F-1916: this IS the human-approval step — a human runs it with an
 * explicit `modelVersion` deliberately, matching "任何一次推进都需要人工
 * 批准，不允许因为代码就绪就自动切换阶段". Never called automatically by
 * `runTrain`.
 */
export async function runPromote(pool: Pool, modelVersion: string): Promise<RunPromoteResult> {
  const model = await getModelByVersion(pool, modelVersion);
  if (!model) {
    throw new Error(`train-ctr-model: no ctr_models row with model_version ${modelVersion}`);
  }

  const shadow = await evaluateAgainstShadowData(pool, model.id);

  // N4 real finding (P1, round 2): re-validate against whatever is
  // CURRENTLY active right now, not the offline_metrics `runTrain` recorded
  // against a baseline that may since have been replaced.
  const { examples } = await loadDataset(pool, model.dataSnapshotVersion);
  const currentActive = await getActiveModel(pool);
  const currentProductionWeights = currentActive?.fusionWeights ?? DEFAULT_FUSION_WEIGHTS;
  const revalidation = evaluateStoredCandidateAgainstCurrentProduction(
    examples,
    model.fusionWeights,
    currentProductionWeights,
  );

  let promoted = false;
  let promotionBlockedReason: string | null = null;

  // design.md 决策 6: 晋升需要"先离线优于当前生产版本，再经影子对比确认"
  // 两个条件同时成立，缺一不可——如实拒绝，不隐藏样本量不足或一致性过低
  // 的事实。
  if (!revalidation.sufficientData) {
    promotionBlockedReason = `离线评估样本量不足（${revalidation.pairCount} 对有效比较，需要至少 30 对），拒绝晋级`;
  } else if (!revalidation.improvedOverProduction) {
    promotionBlockedReason = `新权重未优于当前生产版本（候选一致性 ${revalidation.candidateConcordance} vs 生产 ${revalidation.productionConcordance}），拒绝晋级`;
  } else if (!shadow.sufficientData) {
    promotionBlockedReason = `影子对比真实样本量不足（${shadow.sampleCount} 条，需要至少 30 条），无法确认，拒绝晋级`;
  } else if (!shadow.meetsAgreementThreshold) {
    promotionBlockedReason = `影子对比与真实排序一致性过低（${shadow.topOneAgreementRate}，低于安全阈值），拒绝晋级`;
  } else {
    await setActiveModel(pool, model.id);
    promoted = true;
  }

  return { revalidation, shadow, promoted, promotionBlockedReason };
}

export async function runRollback(pool: Pool, modelVersion: string): Promise<void> {
  const model = await getModelByVersion(pool, modelVersion);
  if (!model) {
    throw new Error(`train-ctr-model: no ctr_models row with model_version ${modelVersion}`);
  }
  // 决策 6: "回滚是指针切换，不需要重新训练" — 复用同一个 setActiveModel。
  await setActiveModel(pool, model.id);
}

function parseArgs(argv: string[]): {
  datasetSnapshotVersion?: string;
  promoteVersion?: string;
  rollbackTo?: string;
} {
  let datasetSnapshotVersion: string | undefined;
  let promoteVersion: string | undefined;
  let rollbackTo: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dataset") datasetSnapshotVersion = argv[++i];
    else if (argv[i] === "--promote") promoteVersion = argv[++i];
    else if (argv[i] === "--rollback-to") rollbackTo = argv[++i];
  }
  return { datasetSnapshotVersion, promoteVersion, rollbackTo };
}

async function main(): Promise<void> {
  const pool = getPool();
  const { datasetSnapshotVersion, promoteVersion, rollbackTo } = parseArgs(process.argv.slice(2));

  if (rollbackTo) {
    await runRollback(pool, rollbackTo);
    console.log(`已回滚：ranking_policy_version 指针切换到 ${rollbackTo}`);
    return;
  }

  if (promoteVersion) {
    const result = await runPromote(pool, promoteVersion);
    console.log(
      `重新验证一致性 ${result.revalidation.candidateConcordance} vs 当前生产 ${result.revalidation.productionConcordance}｜` +
        `影子对比真实样本 ${result.shadow.sampleCount}｜一致性 ${result.shadow.topOneAgreementRate}｜` +
        (result.promoted ? "已晋升为生产版本" : `未晋升：${result.promotionBlockedReason}`),
    );
    return;
  }

  if (!datasetSnapshotVersion) {
    throw new Error(
      "train-ctr-model: --dataset <snapshotVersion>，或 --promote <modelVersion>，或 --rollback-to <modelVersion>",
    );
  }

  const result = await runTrain(pool, datasetSnapshotVersion);
  console.log(
    `模型 ${result.modelVersion} 已登记｜有效比较对（held-out）${result.training.pairCount}｜` +
      `候选一致性 ${result.training.candidateConcordance}｜生产一致性 ${result.training.productionConcordance}｜` +
      `是否优于生产版本 ${result.training.improvedOverProduction}（尚未晋升，需真实影子数据积累后单独执行 --promote，届时会重新对比当前生产版本）`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
