import type { Queryable } from "../../db/pool.js";

/**
 * design.md 决策 6: "新版本晋升前必须先离线优于当前生产版本，再经影子对比
 * 确认（复用 T-1906 的影子调用产生的真实数据）" — this is the second half
 * of that gate. `shadow_ranking_results` (T-1906) already holds every real
 * Python-vs-Go ranking pair recorded in SHADOW stage; this function reads
 * that real data and reports a simple, explainable agreement metric
 * (top-1 match rate — did Python's own live reranking agree with Go's real
 * Top-K on which candidate to put first) rather than trying to re-derive
 * per-candidate reward from `shadow_ranking_results` alone (it has no
 * outcome/rating columns — that link only exists via `dataset-builder.ts`'s
 * own join through `recommendation_candidates`/`interaction_events`, a
 * different concern from this specific gate).
 *
 * N4 real finding (P1, round 1): the original version queried ALL rows in
 * `shadow_ranking_results` with no filter — any 30 old rows from a
 * completely unrelated (or never-promoted) run would satisfy the sample
 * threshold for a BRAND NEW candidate model that had never actually run a
 * single real shadow request itself. Fixed: filtered to `ctr_model_id =
 * modelId` — this candidate's OWN real shadow evidence, and nothing else.
 * T-1907 (用户 2026-09-06 决策) closed the gap this filter's own honest
 * consequence used to name here: `shadow-rerank.ts` now looks up the real
 * active `ctr_models` row on every call and sends its actual weights (not
 * just an opaque id) to Python, which genuinely uses them for
 * `fuse_signals` and echoes the SAME version back only when it truly did
 * so (`services/dispatch-rerank`'s `RankingPolicy`/`run_rerank_pipeline`)
 * — real shadow samples now accumulate against a real candidate model id
 * once one exists and real traffic flows, closing what this comment
 * previously described as a structural zero.
 *
 * N4 real finding (P1, round 1): `sufficientData` alone doesn't check
 * whether the real shadow evidence is actually GOOD — 30 samples that all
 * disagree with Go's real ranking would still "pass" a sample-count-only
 * gate. `meetsAgreementThreshold` is a minimal SANITY check (not a Q-1902
 * business threshold): does this candidate's live shadow behavior even
 * resemble the known-safe Go baseline closely enough to be worth a human's
 * attention, or is it so wildly different that promoting it without
 * further investigation would be reckless. It answers "is this weird?",
 * not "is this better?" — verifying real IMPROVEMENT from shadow data
 * alone is not possible without outcome/reward data shadow_ranking_results
 * doesn't carry (see this doc comment's own first paragraph); that harder
 * question stays open (design.md's own "样本量与工程资源支持" future-work
 * note).
 */
export interface ShadowComparisonResult {
  sampleCount: number;
  topOneAgreementRate: number | null;
  sufficientData: boolean;
  meetsAgreementThreshold: boolean;
}

const DEFAULT_MIN_SHADOW_SAMPLES = 30;
const DEFAULT_MIN_AGREEMENT_RATE = 0.5;

export async function evaluateAgainstShadowData(
  client: Queryable,
  modelId: string,
  options: { minSamples?: number; minAgreementRate?: number } = {},
): Promise<ShadowComparisonResult> {
  const minSamples = options.minSamples ?? DEFAULT_MIN_SHADOW_SAMPLES;
  const minAgreementRate = options.minAgreementRate ?? DEFAULT_MIN_AGREEMENT_RATE;

  const { rows } = await client.query<{
    shadow_ranked_agent_ids: string[];
    real_ranked_agent_ids: string[];
  }>(
    `SELECT shadow_ranked_agent_ids, real_ranked_agent_ids
       FROM shadow_ranking_results
      WHERE ctr_model_id = $1`,
    [modelId],
  );

  const sampleCount = rows.length;
  if (sampleCount === 0) {
    return {
      sampleCount,
      topOneAgreementRate: null,
      sufficientData: false,
      meetsAgreementThreshold: false,
    };
  }

  const agreements = rows.filter(
    (row) => row.shadow_ranked_agent_ids[0] === row.real_ranked_agent_ids[0],
  ).length;
  const topOneAgreementRate = agreements / sampleCount;

  return {
    sampleCount,
    topOneAgreementRate,
    sufficientData: sampleCount >= minSamples,
    meetsAgreementThreshold: topOneAgreementRate >= minAgreementRate,
  };
}

/**
 * T-1907 (F-1910/F-1916 release-stage gate), 用户 2026-09-06 Q-1902 决策
 * 1+2: a DIFFERENT sample-sufficiency question from `evaluateAgainstShadowData`
 * above — that function counts total ROWS ever recorded for a model with
 * no time bound (T-1905's own promotion gate, an all-time engineering
 * sanity check); this one counts DISTINCT TASKS within a trailing window
 * (default 30 days), per the user's explicit requirement: "最近 30 天内至少
 * 200 个不同 task 的有效 shadow comparison；不得使用生命周期累计数，也不得
 * 让同一 task 重复计数". A task re-matched more than once within the window
 * contributes ONE data point (its most recent comparison), not one per
 * match — re-matching the same task repeatedly must not be a way to
 * artificially inflate the sample count.
 */
export interface ReleaseGateShadowResult {
  distinctTaskCount: number;
  topOneAgreementRate: number | null;
  sufficientSampleSize: boolean;
  meetsAgreementThreshold: boolean;
}

const RELEASE_GATE_MIN_DISTINCT_TASKS = 200;
const RELEASE_GATE_MIN_AGREEMENT_RATE = 0.65;
const RELEASE_GATE_WINDOW_DAYS = 30;

export async function evaluateShadowDataForReleaseGate(
  client: Queryable,
  modelId: string,
  options: { windowDays?: number; minDistinctTasks?: number; minAgreementRate?: number } = {},
): Promise<ReleaseGateShadowResult> {
  const windowDays = options.windowDays ?? RELEASE_GATE_WINDOW_DAYS;
  const minDistinctTasks = options.minDistinctTasks ?? RELEASE_GATE_MIN_DISTINCT_TASKS;
  const minAgreementRate = options.minAgreementRate ?? RELEASE_GATE_MIN_AGREEMENT_RATE;

  const { rows } = await client.query<{
    task_id: string;
    shadow_ranked_agent_ids: string[];
    real_ranked_agent_ids: string[];
    computed_at: Date;
  }>(
    `SELECT rr.task_id, sr.shadow_ranked_agent_ids, sr.real_ranked_agent_ids, sr.computed_at
       FROM shadow_ranking_results sr
       JOIN recommendation_runs rr ON rr.id = sr.run_id
      WHERE sr.ctr_model_id = $1
        AND sr.computed_at >= now() - ($2::int * interval '1 day')`,
    [modelId, windowDays],
  );

  const latestByTask = new Map<
    string,
    { shadowFirst: string | undefined; realFirst: string | undefined; computedAt: Date }
  >();
  for (const row of rows) {
    const existing = latestByTask.get(row.task_id);
    if (!existing || row.computed_at > existing.computedAt) {
      latestByTask.set(row.task_id, {
        shadowFirst: row.shadow_ranked_agent_ids[0],
        realFirst: row.real_ranked_agent_ids[0],
        computedAt: row.computed_at,
      });
    }
  }

  const distinctTaskCount = latestByTask.size;
  if (distinctTaskCount === 0) {
    return {
      distinctTaskCount: 0,
      topOneAgreementRate: null,
      sufficientSampleSize: false,
      meetsAgreementThreshold: false,
    };
  }

  const agreements = [...latestByTask.values()].filter(
    (v) => v.shadowFirst !== undefined && v.shadowFirst === v.realFirst,
  ).length;
  const topOneAgreementRate = agreements / distinctTaskCount;

  return {
    distinctTaskCount,
    topOneAgreementRate,
    sufficientSampleSize: distinctTaskCount >= minDistinctTasks,
    meetsAgreementThreshold: topOneAgreementRate >= minAgreementRate,
  };
}
