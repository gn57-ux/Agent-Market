// Feature 19 (ctr-online-learning), T-1904 (F-1906/AC-1904 前半).
//
// Standalone CLI script (design.md's own interface contract: "训练脚本：
// 独立命令行工具，不是 HTTP API") — thin shell around
// `dataset-builder.ts`'s `buildTrainingDataset` (the actual, independently
// testable logic). This file's only real job: pick `asOf`/`featureVersion`,
// serialize the result to a versioned JSONL file under
// `var/ctr-training-datasets/` (same local-filesystem convention as
// Feature 9's `deliverables/storage.local.ts`), and register its metadata
// in `ctr_training_datasets`.
//
// Run as `pnpm --filter @agent-market/api build-ctr-training-dataset`.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import {
  buildTrainingDataset,
  type DatasetBuildResult,
} from "../src/modules/ctr-training/dataset-builder.js";
import {
  detectAnomalousSessions,
  resolveAffectedRunIds,
} from "../src/modules/ctr-training/fairness-monitor.js";

/**
 * Bumped only when `dataset-builder.ts`'s own row shape changes (a real
 * schema change to what a training example looks like) — NOT per run.
 * `ctr_models.feature_version` (design.md) is meant to detect "was this
 * model trained against a feature shape that no longer exists," which
 * only a stable, code-versioned string (not a timestamp) can answer.
 */
export const FEATURE_VERSION = "v1";

function outputDir(): string {
  return path.resolve(process.cwd(), process.env.CTR_DATASET_DIR ?? "var/ctr-training-datasets");
}

/**
 * `data_snapshot_version` — unlike `FEATURE_VERSION`, this one genuinely
 * is per-run (design.md's own field name: "记录数据快照版本"): each
 * invocation captures a distinct moment of `interaction_events`, and
 * `ctr_models.data_snapshot_version` (T-1905) needs to name exactly which
 * snapshot a given model was trained against.
 */
function generateSnapshotVersion(asOf: Date): string {
  return `${asOf.toISOString()}-${randomUUID().slice(0, 8)}`;
}

export async function runBuild(
  pool: Pool,
  options: { asOf?: Date } = {},
): Promise<{
  snapshotVersion: string;
  outputPath: string;
  result: DatasetBuildResult;
  excludedSessionCount: number;
  excludedRunCount: number;
}> {
  const asOf = options.asOf ?? new Date();
  // F-1912/T-1908: the real "识别并排除" wiring — this is the one real
  // caller that turns `fairness-monitor.ts`'s detection into an actual
  // exclusion, bounded to the SAME `asOf` this snapshot itself is bounded
  // to (AC-1904's own reproducibility contract: re-running this exact
  // snapshot later must not silently change which sessions were excluded
  // because more anomalous activity accumulated after `asOf`). N4 real
  // finding (P1, round 2): flagged SESSION ids can never match an
  // `EXPOSURE` row's own session id (see `dataset-builder.ts`'s own doc
  // comment) — `resolveAffectedRunIds` bridges the two via the real
  // `run_id` correlation a flagged session's own events reference.
  const anomalousSessions = await detectAnomalousSessions(pool, {
    since: new Date(0),
    until: asOf,
  });
  const excludedRunIds = await resolveAffectedRunIds(pool, anomalousSessions.flaggedSessionIds);

  const result = await buildTrainingDataset(pool, { asOf, excludedRunIds });
  const snapshotVersion = generateSnapshotVersion(result.asOf);

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, `${snapshotVersion}.jsonl`);
  const jsonl = result.matureExamples.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(outputPath, jsonl, "utf8");

  const censoredCandidateCount = result.matureExamples.filter((row) => !row.wasAccepted).length;

  // N4 real finding (P2, round 1): the file used to be written before this
  // INSERT with no cleanup on failure — a migration gap, a dropped
  // connection, or a constraint error here would leave a real, unregistered
  // JSONL file behind permanently (and a re-run would just create another
  // orphan alongside it, rather than either succeeding cleanly or leaving
  // no trace). On INSERT failure, delete the just-written file and rethrow
  // — this script's own contract is "either both the file and its registry
  // row exist, or neither does."
  try {
    await pool.query(
      `INSERT INTO ctr_training_datasets
         (data_snapshot_version, feature_version, as_of, mature_example_count, immature_exposure_count, censored_candidate_count, output_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        snapshotVersion,
        FEATURE_VERSION,
        result.asOf.toISOString(),
        result.matureExamples.length,
        result.immatureExposureCount,
        censoredCandidateCount,
        outputPath,
      ],
    );
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }

  return {
    snapshotVersion,
    outputPath,
    result,
    excludedSessionCount: anomalousSessions.flaggedSessionIds.length,
    excludedRunCount: excludedRunIds.length,
  };
}

async function main(): Promise<void> {
  const pool = getPool();
  const { snapshotVersion, outputPath, result, excludedSessionCount, excludedRunCount } =
    await runBuild(pool);
  console.log(
    `数据集快照 ${snapshotVersion} 已生成：${result.matureExamples.length} 条成熟样本` +
      `（其中 ${result.matureExamples.filter((r) => !r.wasAccepted).length} 条为未被选中候选的删失记录），` +
      `${result.immatureExposureCount} 条曝光因任务尚未到达终态而延后，` +
      `${excludedSessionCount} 个异常会话（F-1912 刷曝光/刷点击识别）关联 ${excludedRunCount} 个撮合批次已被排除，` +
      `输出文件：${outputPath}`,
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
