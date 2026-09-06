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
 * A direct, honest consequence (not a bug to work around): until Python
 * actually tags a `/rerank` response's `rankingPolicyVersion` with a real
 * candidate model id (no writer does this yet — see `dispatch_rerank_runs`
 * .doc comment), THIS FILTER MEANS EVERY CANDIDATE MODEL REPORTS ZERO
 * shadow samples, and promotion can never pass the shadow gate — matching
 * tasks.md's own documented resolution exactly ("T-1905 首次运行只做离线
 * 评估，晋升判断待 T-1906/T-1912 上线后才能真正执行"). Wiring a candidate
 * model's weights into a live, tagged shadow `/rerank` call is real future
 * work, not invented here to force a pass.
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
