import type { Pool } from "pg";
import { callRerankService, type RerankRequestBody } from "./rerank-client.js";
import {
  insertDispatchRerankRun,
  insertShadowRankingResult,
  resolveDispatchRerankOutcome,
} from "./rerank-repository.js";
import { toReputationSignalsWire, type ReputationSignalsDigest } from "./reputation-signals.js";
import { getCurrentReleaseStage } from "../ctr-training/release-gate.js";

export interface RunShadowRerankInput {
  runId: string;
  taskDescription: string;
  /** Go's real Top-K result — `rank` is required (not just `agentId`/
   * `score`) so this function can derive `shadow_ranking_results
   * .real_ranked_agent_ids` from Go's own authoritative order rather than
   * assuming this array happens to already be rank-sorted. */
  recommendations: Array<{ agentId: string; rank: number; score: number }>;
  reputationSignalsDigestByAgentId: Map<string, ReputationSignalsDigest>;
  semanticSimilarityByAgentId: Map<string, number | undefined>;
  /** F-1919: the single trace id `matchTask` generated for this whole
   * `/match` call chain — reused here so this leg's `dispatch_rerank_runs`
   * row correlates with Go's own log line for the SAME request. */
  traceId: string;
}

/**
 * F-1914/F-1915 (T-1912): the actual call-chain insertion point — Node,
 * having already received Go's `v0.2` Top-K result and persisted the run,
 * calls Python's `/rerank` exactly once more. design.md's own architecture
 * (v1.3): this stays entirely within `matchTask`'s existing request/
 * response cycle (no new background job infra), so a slow local
 * `qwen3:8b` call (T-1911's own doc comment: tens of seconds measured for
 * a handful of candidates) genuinely does add to `/match`'s own response
 * latency today — `rerank-client.ts`'s timeout bounds how much, and
 * F-1910's later latency/stability gates (T-1907) are the real mechanism
 * that uses THIS call's own recorded `latencyMs` to decide whether
 * reranking is fit to ever leave SHADOW; this function does not attempt
 * to solve that latency itself.
 *
 * `stage` (N4 fix, T-1907): read fresh from `release_stage_state`
 * (`release-gate.ts`'s own single source of truth) on every real call,
 * never hardcoded — so a real GRADUAL/PRIMARY advancement is genuinely
 * observable in what Python receives and what `dispatch_rerank_runs.stage`
 * records, not silently ignored. **What this does NOT do** (an explicit,
 * documented limitation, not an oversight): this function's return value
 * stays `void` regardless of stage — `matchTask`'s own response is built
 * entirely from `matchResponse` (Go's result) BEFORE this function is ever
 * called, so a real GRADUAL/PRIMARY stage still never changes what a real
 * user is shown; `adopted` stays `false` unconditionally for the same
 * reason. Building real traffic adoption (routing some/all real responses
 * through Python's reranked order once past SHADOW) is a separate,
 * larger, NOT-yet-authorized follow-up — it needs its own design decisions
 * (what fraction of GRADUAL traffic, how/where the response construction
 * changes) that were never part of T-1907's scope (门槛配置/计算/拒绝路径/
 * 自动回滚), and inventing one here would be exactly the kind of
 * unauthorized scope expansion CLAUDE.md 原则 1 warns against.
 *
 * This function never throws — a Python/network failure degrades to a
 * logged `TIMEOUT`/`ERROR` `dispatch_rerank_runs` row (F-1913/AC-1908),
 * never a failed `/match` request. It only assembles the request and
 * records the real observability row (F-1919) — the run itself already
 * committed before this is called, so there is no shared transaction to
 * roll back if this fails.
 */
export async function runShadowRerank(pool: Pool, input: RunShadowRerankInput): Promise<void> {
  // N4 P1 fix (round 2): `getCurrentReleaseStage` genuinely CAN throw (a
  // missing singleton row, or any transient DB error on this one query) —
  // letting that propagate would break this function's own "never throws"
  // contract for the FIRST time in its history and turn an already-
  // decided-successful `/match` response into a failed one, since
  // `routes.ts` calls this function unguarded. Falls back to `"SHADOW"`
  // (the always-safe stage — Python is told nothing has actually been
  // approved for wider exposure) rather than letting a read failure here
  // ever affect a real user-facing request.
  let stage: Awaited<ReturnType<typeof getCurrentReleaseStage>>;
  try {
    stage = await getCurrentReleaseStage(pool);
  } catch (error) {
    stage = "SHADOW";
    console.error(
      "runShadowRerank: failed to read the real release stage, defaulting to SHADOW",
      error,
    );
  }

  const request: RerankRequestBody = {
    candidates: input.recommendations.map((recommendation) => {
      const digest = input.reputationSignalsDigestByAgentId.get(recommendation.agentId);
      return {
        agentId: recommendation.agentId,
        v0Score: recommendation.score,
        signals: digest ? toReputationSignalsWire(digest) : null,
        semanticSimilarity: input.semanticSimilarityByAgentId.get(recommendation.agentId) ?? null,
      };
    }),
    taskDescription: input.taskDescription,
    stage,
  };

  const result = await callRerankService(request, { traceId: input.traceId });

  // N4 real finding (P2, round 1): a successful rerank's `dispatch_rerank_
  // runs` row and its `shadow_ranking_results` row are the SAME logical
  // observation of one call — writing them as two independent statements
  // let a transient failure on the second insert leave the first
  // permanently committed with no corresponding shadow comparison row,
  // silently corrupting T-1905/T-1908's later offline analysis. Both
  // inserts now share one transaction: either both commit or neither does.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const rerankRunId = await insertDispatchRerankRun(client, {
      runId: input.runId,
      stage,
      rerankServiceVersion: result.response?.rerankServiceVersion ?? null,
      // No `ctr_models` row exists yet (T-1905 not built) — every real
      // `/rerank` response's `rankingPolicyVersion` is `null` today.
      rankingPolicyVersion: result.response?.rankingPolicyVersion ?? null,
      outcome: resolveDispatchRerankOutcome(result.outcome, result.response?.llmAdopted),
      latencyMs: result.latencyMs,
      adopted: false,
      traceId: result.traceId,
    });

    // F-1906/AC-1905: only a real response (SUCCESS/DEGRADED) has a
    // `shadowRankedAgentIds` order to compare against Go's real order — a
    // TIMEOUT/ERROR call produced no ranking at all, so there is nothing
    // for `shadow_ranking_results` to hold beyond what's already recorded
    // above (`resolveDispatchRerankOutcome`'s own doc comment).
    if (result.response) {
      await insertShadowRankingResult(client, {
        runId: input.runId,
        rerankRunId,
        ctrModelId: result.response.rankingPolicyVersion ?? null,
        shadowRankedAgentIds: result.response.rankedAgentIds,
        realRankedAgentIds: [...input.recommendations]
          .sort((a, b) => a.rank - b.rank)
          .map((recommendation) => recommendation.agentId),
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // Losing one observability row is not a reason to fail `/match` —
    // this function's own doc comment's "never throws" contract holds
    // even when the LOGGING step itself fails (e.g. a transient DB
    // error), not just when the Python call fails.
    console.error("runShadowRerank: failed to record shadow rerank observability", error);
  } finally {
    client.release();
  }
}
