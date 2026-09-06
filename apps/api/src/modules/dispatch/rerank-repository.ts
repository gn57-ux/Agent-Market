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
