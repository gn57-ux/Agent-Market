import type { Pool } from "pg";
import { callRerankService, type RerankRequestBody } from "./rerank-client.js";
import {
  insertDispatchRerankRun,
  insertShadowRankingResult,
  resolveDispatchRerankOutcome,
} from "./rerank-repository.js";
import { toReputationSignalsWire, type ReputationSignalsDigest } from "./reputation-signals.js";
import { getCurrentReleaseStage } from "../ctr-training/release-gate.js";
import { getActiveModel } from "../ctr-training/ctr-model-repository.js";

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

  // T-1907 (用户 2026-09-06 决策): the real active `ranking_policy_version`
  // (if any) is looked up HERE, fresh, on every call — never cached,
  // never guessed from client input, never a constant — and its actual
  // fusion weights are sent to Python so the round-tripped
  // `rankingPolicyVersion` in the response genuinely corresponds to what
  // was computed (see `rerank-repository.ts`'s own doc comment on why the
  // response value, not this lookup's own value, is what actually gets
  // persisted below). A failed lookup degrades the SAME way a failed
  // stage read does — this function's "never throws" contract covers
  // this new read too, and omitting `rankingPolicy` entirely is the
  // existing, always-safe default (Go's fixed weights, `null` version).
  let activeModel: Awaited<ReturnType<typeof getActiveModel>> = null;
  try {
    activeModel = await getActiveModel(pool);
  } catch (error) {
    activeModel = null;
    console.error(
      "runShadowRerank: failed to read the active ranking_policy_version, omitting it",
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
    rankingPolicy: activeModel
      ? { version: activeModel.id, weights: activeModel.fusionWeights }
      : null,
  };

  const result = await callRerankService(request, { traceId: input.traceId });

  // N4 real finding (P1, round 2, T-1907): Python's response is the sole
  // authority on whether a real policy was used (see the doc comment
  // below), but that authority only extends to CONFIRMING the exact
  // version this call itself sent — it must never be trusted to name an
  // arbitrary OTHER existing model. A version-drifted, buggy, or
  // compromised Python process echoing back some other real `ctr_models`
  // .id (one that passes the `ctr_model_id` foreign key just as validly
  // as the correct one) would otherwise get silently attributed to THIS
  // call's shadow evidence, corrupting `evaluateReleaseGate`'s sample
  // attribution and — depending on which model's evidence looked
  // better — could bias `advanceReleaseStage` itself. Only an EXACT match
  // against the version this call actually requested is trusted; anything
  // else (including "no policy was requested at all") degrades to `null`,
  // the same fail-closed default as "Python couldn't use it."
  const requestedRankingPolicyVersion = activeModel?.id ?? null;
  const confirmedRankingPolicyVersion =
    result.response?.rankingPolicyVersion != null &&
    result.response.rankingPolicyVersion === requestedRankingPolicyVersion
      ? result.response.rankingPolicyVersion
      : null;
  if (
    result.response?.rankingPolicyVersion != null &&
    result.response.rankingPolicyVersion !== requestedRankingPolicyVersion
  ) {
    console.error(
      "runShadowRerank: Python's response named a ranking_policy_version that does not match what this call requested — refusing to attribute this evidence to any model",
      { requested: requestedRankingPolicyVersion, received: result.response.rankingPolicyVersion },
    );
  }

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
      // T-1907 (用户 2026-09-06 决策): read off the RESPONSE, never off
      // `activeModel`/the request this function just sent — Python's own
      // response is the one source of truth for "was a real policy
      // actually used for this computation" (see this function's own doc
      // comment on `rankingPolicy` above, and `models.py`'s
      // `RankingPolicy`/`run_rerank_pipeline` on the Python side for why
      // the two can never disagree once a response comes back at all) —
      // but ONLY once confirmed to match what this call actually
      // requested (`confirmedRankingPolicyVersion` above, N4 P1 fix round
      // 2). `null` here can mean "no active model existed," "Python
      // itself couldn't use the supplied one," OR "Python's answer didn't
      // match what was asked" — all three are equally and correctly
      // "don't attribute this evidence to any candidate model."
      rankingPolicyVersion: confirmedRankingPolicyVersion,
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
        ctrModelId: confirmedRankingPolicyVersion,
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
