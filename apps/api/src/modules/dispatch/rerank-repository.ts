import type { Queryable } from "../../db/pool.js";
import type { RerankCallOutcome } from "./rerank-client.js";

/**
 * F-1919 (T-1912): the one function that knows `dispatch_rerank_runs`'s
 * columns (CLAUDE.md 原则 6). `rerankServiceVersion`/`rankingPolicyVersion`
 * are two independent columns (F-1922) — never merged or derived from one
 * another.
 */
export interface InsertDispatchRerankRunInput {
  runId: string;
  stage: "SHADOW" | "GRADUAL" | "PRIMARY";
  rerankServiceVersion: string | null;
  /** A `ctr_models.id` UUID, once T-1905 registers a real trained policy —
   * always `null` today (no `ctr_models` row exists yet). */
  rankingPolicyVersion: string | null;
  outcome: "SUCCESS" | "TIMEOUT" | "ERROR" | "DEGRADED";
  latencyMs: number;
  adopted: boolean;
  traceId: string;
}

export async function insertDispatchRerankRun(
  client: Queryable,
  input: InsertDispatchRerankRunInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO dispatch_rerank_runs
       (run_id, stage, rerank_service_version, ranking_policy_version, outcome, latency_ms, adopted, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.runId,
      input.stage,
      // rerank_service_version is NOT NULL (design.md's own schema) — a
      // call that never reached the Python service at all (TIMEOUT/ERROR
      // with no response body) genuinely has no service version to
      // report; a fixed placeholder records that this row represents a
      // failed call, not a real service response, without violating the
      // column's own NOT NULL constraint.
      input.rerankServiceVersion ?? "unavailable",
      input.rankingPolicyVersion,
      input.outcome,
      input.latencyMs,
      input.adopted,
      input.traceId,
    ],
  );
  const row = rows[0];
  if (!row) {
    // `INSERT ... RETURNING id` on a successful query always returns
    // exactly one row — this is defensive against a shape this driver
    // call can't actually produce, not an expected branch.
    throw new Error("insertDispatchRerankRun: INSERT ... RETURNING id returned no row");
  }
  return row.id;
}

/**
 * F-1906 (T-1906): `shadow_ranking_results` only ever gets a row when the
 * Python call actually produced a usable ranking (`SUCCESS`/`DEGRADED` —
 * see `resolveDispatchRerankOutcome`'s own doc comment) — a `TIMEOUT`/
 * `ERROR` call has no `shadowRankedAgentIds` to compare against Go's real
 * order, so there is nothing meaningful to persist here (the failed
 * attempt itself is still fully recorded in `dispatch_rerank_runs`).
 * `ctrModelId` mirrors `dispatch_rerank_runs.ranking_policy_version` —
 * always `null` until T-1905 registers a real trained policy.
 */
export interface InsertShadowRankingResultInput {
  runId: string;
  rerankRunId: string;
  ctrModelId: string | null;
  shadowRankedAgentIds: string[];
  realRankedAgentIds: string[];
}

export async function insertShadowRankingResult(
  client: Queryable,
  input: InsertShadowRankingResultInput,
): Promise<void> {
  await client.query(
    `INSERT INTO shadow_ranking_results
       (run_id, rerank_run_id, ctr_model_id, shadow_ranked_agent_ids, real_ranked_agent_ids)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.runId,
      input.rerankRunId,
      input.ctrModelId,
      JSON.stringify(input.shadowRankedAgentIds),
      JSON.stringify(input.realRankedAgentIds),
    ],
  );
}

/**
 * F-1919 (T-1912): maps this call's real outcome to `dispatch_rerank_runs
 * .outcome`'s closed enum. A network/timeout/HTTP failure is `TIMEOUT`/
 * `ERROR` (the call itself didn't produce a usable response); a real 200
 * response that internally fell back to the deterministic fusion order
 * (`llmAdopted: false`, `pipeline.py`'s own state) is `DEGRADED` — a
 * distinct outcome from `SUCCESS`, since the call succeeded but its
 * result wasn't a real qwen3:8b ranking.
 */
export function resolveDispatchRerankOutcome(
  callOutcome: RerankCallOutcome,
  llmAdopted: boolean | undefined,
): "SUCCESS" | "TIMEOUT" | "ERROR" | "DEGRADED" {
  if (callOutcome === "TIMEOUT") return "TIMEOUT";
  if (callOutcome === "ERROR") return "ERROR";
  return llmAdopted ? "SUCCESS" : "DEGRADED";
}

/**
 * T-1907 (F-1910/F-1916 release-stage gate), 用户 2026-09-06 Q-1902 决策 4:
 * "进入 GRADUAL/PRIMARY 必须同时满足 P95 ≤ 8 秒、错误与超时合计比例 < 2%，
 * 指标使用与样本量相同的最近 30 天窗口". Deliberately scoped to EVERY real
 * `dispatch_rerank_runs` row in the window, regardless of
 * `ranking_policy_version` — unlike the shadow-agreement/effect gates
 * (which must isolate a specific candidate model's own evidence), latency
 * and error/timeout rate are properties of the Python service call itself
 * (dominated by the local LLM inference time — T-1911's own measured
 * "tens of seconds" — which fusion weights never affect), not of which
 * `ranking_policy_version` happened to be active for a given call. Using
 * every real call the service actually handled is the more honest,
 * strictly MORE available signal — restricting to one (today, always
 * unset) `ranking_policy_version` would make this gate permanently
 * "no data" for the same architectural reason `evaluateShadowDataFor
 * ReleaseGate` is.
 */
export interface RerankStabilityResult {
  sampleCount: number;
  p95LatencyMs: number | null;
  errorOrTimeoutRate: number | null;
  hasData: boolean;
  meetsLatencyThreshold: boolean;
  meetsErrorRateThreshold: boolean;
}

const RELEASE_GATE_MAX_P95_LATENCY_MS = 8_000;
const RELEASE_GATE_MAX_ERROR_OR_TIMEOUT_RATE = 0.02;
const RELEASE_GATE_STABILITY_WINDOW_DAYS = 30;

export async function evaluateRerankStabilityForReleaseGate(
  client: Queryable,
  options: {
    windowDays?: number;
    maxP95LatencyMs?: number;
    maxErrorOrTimeoutRate?: number;
  } = {},
): Promise<RerankStabilityResult> {
  const windowDays = options.windowDays ?? RELEASE_GATE_STABILITY_WINDOW_DAYS;
  const maxP95LatencyMs = options.maxP95LatencyMs ?? RELEASE_GATE_MAX_P95_LATENCY_MS;
  const maxErrorOrTimeoutRate =
    options.maxErrorOrTimeoutRate ?? RELEASE_GATE_MAX_ERROR_OR_TIMEOUT_RATE;

  const { rows } = await client.query<{
    sample_count: string;
    p95_latency_ms: string | null;
    error_or_timeout_count: string;
  }>(
    `SELECT
       count(*) AS sample_count,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
       count(*) FILTER (WHERE outcome IN ('ERROR', 'TIMEOUT')) AS error_or_timeout_count
     FROM dispatch_rerank_runs
     WHERE created_at >= now() - ($1::int * interval '1 day')`,
    [windowDays],
  );

  const row = rows[0];
  const sampleCount = row ? Number(row.sample_count) : 0;
  if (!row || sampleCount === 0) {
    return {
      sampleCount: 0,
      p95LatencyMs: null,
      errorOrTimeoutRate: null,
      hasData: false,
      meetsLatencyThreshold: false,
      meetsErrorRateThreshold: false,
    };
  }

  const p95LatencyMs = row.p95_latency_ms === null ? null : Number(row.p95_latency_ms);
  const errorOrTimeoutRate = Number(row.error_or_timeout_count) / sampleCount;

  return {
    sampleCount,
    p95LatencyMs,
    errorOrTimeoutRate,
    hasData: true,
    meetsLatencyThreshold: p95LatencyMs !== null && p95LatencyMs <= maxP95LatencyMs,
    meetsErrorRateThreshold: errorOrTimeoutRate < maxErrorOrTimeoutRate,
  };
}
