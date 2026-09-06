import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { buildTrainingDataset } from "./dataset-builder.js";
import { DEFAULT_FUSION_WEIGHTS } from "./fusion-weights.js";
import { getActiveModel } from "./ctr-model-repository.js";
import { evaluateStoredCandidateAgainstCurrentProduction } from "./model-trainer.js";
import { evaluateShadowDataForReleaseGate } from "./shadow-comparison.js";
import { evaluateRerankStabilityForReleaseGate } from "../dispatch/rerank-repository.js";

/**
 * F-1910/F-1916 (T-1907), 用户 2026-09-06 Q-1902 决策: the three-stage
 * release-rhythm gate (SHADOW → GRADUAL → PRIMARY). This module is the
 * ONLY place that computes whether advancing the CURRENT stage is allowed,
 * and the only place that changes `release_stage_state` (CLAUDE.md 原则
 * 6) — `shadow-rerank.ts` (or any future adoption-path code) reads the
 * resulting stage but never decides it.
 *
 * **T-1907 round 3 (用户 2026-09-06 决策)**: the real `ranking_policy_
 * version` propagation this gate's sample-size dimension depends on is
 * now genuinely wired end to end — `shadow-rerank.ts` looks up the real
 * active `ctr_models` row on every call and sends its actual fusion
 * weights (not just an opaque id) to Python; Python's `RankingPolicy`/
 * `run_rerank_pipeline` genuinely uses those weights for `fuse_signals`
 * and echoes the SAME version back only when it truly did; Node persists
 * exactly what the response says (never what it originally requested —
 * see `rerank-repository.ts`'s own `rankingPolicyVersion` doc comment).
 * Real shadow samples now accumulate against a real candidate model id
 * as real traffic flows, and the sample/agreement gates below can
 * genuinely be satisfied by real data — this is no longer a structural
 * zero, which is exactly what the user's 2026-09-06 follow-up instruction
 * required ("不得用合成数据冒充上线证据，也不得宣称真实晋升已经验证" —
 * satisfied by making the real pipeline itself produce the evidence,
 * never by fabricating rows).
 */
export type ReleaseStage = "SHADOW" | "GRADUAL" | "PRIMARY";

const STAGE_ORDER: ReleaseStage[] = ["SHADOW", "GRADUAL", "PRIMARY"];
const DEFAULT_WINDOW_DAYS = 30;

export interface ReleaseGateSnapshot {
  windowDays: number;
  evaluatedAt: string;
  readiness: { ready: boolean; blockedReason: string | null };
  sampleGate: {
    distinctTaskCount: number;
    sufficientSampleSize: boolean;
  } | null;
  agreementGate: {
    topOneAgreementRate: number | null;
    meetsThreshold: boolean;
  } | null;
  effectGate: {
    candidateConcordance: number | null;
    productionConcordance: number | null;
    pairCount: number;
    sufficientData: boolean;
    notRegressed: boolean;
  } | null;
  stabilityGate: {
    p95LatencyMs: number | null;
    errorOrTimeoutRate: number | null;
    hasData: boolean;
    meetsLatencyThreshold: boolean;
    meetsErrorRateThreshold: boolean;
  } | null;
  eligibleForAdvancement: boolean;
  blockedReasons: string[];
}

/**
 * Pure evaluation — never mutates `release_stage_state`. Re-run fresh on
 * every real advancement/rollback decision (never trust a cached prior
 * result), matching this codebase's established `runPromote` re-validation
 * convention (T-1905's own N4 fix: promotion re-checks against whatever is
 * CURRENTLY true, not a stale snapshot).
 *
 * N4 P2 fix (round 1): accepts `Queryable` (a plain `Pool` OR an
 * already-checked-out `PoolClient`), not `Pool` specifically — the same
 * "deadlock under pool exhaustion" class of bug Feature 20's T-2008 round 1
 * P1 already found and fixed. `advanceReleaseStage`/`checkAndAutoRollback`
 * hold the singleton row's lock on ONE checked-out client for their whole
 * transaction; calling this function with the bare `pool` from inside that
 * transaction would require a SECOND connection just to evaluate the gate,
 * and under a small/exhausted pool (or many concurrent advance/rollback
 * attempts all waiting on the same row lock) every in-flight request would
 * hold one connection while waiting for a second that never frees up.
 * Passing the SAME `client` through avoids ever needing a second
 * connection for one atomic decision.
 */
export async function evaluateReleaseGate(
  client: Queryable,
  options: { windowDays?: number } = {},
): Promise<ReleaseGateSnapshot> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const evaluatedAt = new Date().toISOString();
  const blockedReasons: string[] = [];

  // Fail-closed readiness check (用户决策: "缺少有效生产基线...一律禁止晋
  // 升") — with no promoted `ranking_policy_version` at all, there is no
  // real candidate behavior to hold to any of the three numeric gates
  // below; refuse immediately rather than evaluating against a
  // meaningless/undefined "candidate".
  const activeModel = await getActiveModel(client);
  if (!activeModel) {
    const blockedReason = "无生产基线：ctr_models 尚无 is_active 版本，无法评估晋升门槛";
    return {
      windowDays,
      evaluatedAt,
      readiness: { ready: false, blockedReason },
      sampleGate: null,
      agreementGate: null,
      effectGate: null,
      stabilityGate: null,
      eligibleForAdvancement: false,
      blockedReasons: [blockedReason],
    };
  }

  // Gate 1+2 (Q-1902 决策 1/2): distinct-task sample size + top-1 agreement
  // rate, both over the trailing window, both scoped to THIS active
  // model's own real shadow evidence.
  const shadow = await evaluateShadowDataForReleaseGate(client, activeModel.id, { windowDays });
  if (!shadow.sufficientSampleSize) {
    blockedReasons.push(
      `样本量不足：最近 ${windowDays} 天内仅 ${shadow.distinctTaskCount} 个不同 task 的真实 shadow comparison，需要至少 200 个`,
    );
  }
  if (!shadow.meetsAgreementThreshold) {
    blockedReasons.push(
      `排序一致率不达标：${shadow.topOneAgreementRate ?? "无法计算（无样本）"}，需要 ≥ 0.65`,
    );
  }

  // Gate 3 (Q-1902 决策 3): effect gate. "生产" here means Go v0.2's real
  // fixed weights (`DEFAULT_FUSION_WEIGHTS`) — what real users are
  // ACTUALLY served today, not `ctr_models`'s internal training-time
  // comparison baseline (which is a different, narrower question T-1905's
  // own promotion gate already answers). The candidate is the currently
  // ACTIVE `ranking_policy_version`'s weights — the real question this
  // gate answers is "if we let this candidate start actually affecting
  // real responses, would it, on FRESH real data, still be at least as
  // good as what's really deployed today". Concordance-based (not a raw
  // mean-reward difference) because concordance is computable directly
  // from real logged accept/reward pairs with NO counterfactual/off-policy
  // correction needed (unlike estimating "what reward the candidate's OWN
  // ranking would have produced had it been shown" — a genuinely
  // unresolved question, Q-1904, left open on purpose). A candidate that
  // ranks real historical outcome pairs no better than Go's fixed weights
  // do is "regressed" for this gate's purposes.
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const dataset = await buildTrainingDataset(client, { since });
  const effect = evaluateStoredCandidateAgainstCurrentProduction(
    dataset.matureExamples,
    activeModel.fusionWeights,
    DEFAULT_FUSION_WEIGHTS,
  );
  const notRegressed =
    effect.sufficientData && effect.candidateConcordance >= effect.productionConcordance;
  if (!effect.sufficientData) {
    blockedReasons.push(
      `效果门槛样本关联不完整：最近 ${windowDays} 天内仅 ${effect.pairCount} 对可比较的真实历史结果，指标无法计算`,
    );
  } else if (!notRegressed) {
    blockedReasons.push(
      `效果门槛未通过：候选一致性 ${effect.candidateConcordance} 相对 Go v0.2 基线 ${effect.productionConcordance} 出现下降`,
    );
  }

  // Gate 4 (Q-1902 决策 4): stability gate — P95 延迟 + 错误/超时比例,
  // service-wide (see `evaluateRerankStabilityForReleaseGate`'s own doc
  // comment for why this is not scoped to one `ranking_policy_version`).
  const stability = await evaluateRerankStabilityForReleaseGate(client, { windowDays });
  if (!stability.hasData) {
    blockedReasons.push(`稳定性门槛无数据：最近 ${windowDays} 天内没有任何真实 /rerank 调用记录`);
  } else {
    if (!stability.meetsLatencyThreshold) {
      blockedReasons.push(`P95 延迟 ${stability.p95LatencyMs}ms 超过 8000ms 上限`);
    }
    if (!stability.meetsErrorRateThreshold) {
      blockedReasons.push(
        `错误/超时比例 ${stability.errorOrTimeoutRate} 超过 2% 上限（样本 ${stability.sampleCount} 条）`,
      );
    }
  }

  return {
    windowDays,
    evaluatedAt,
    readiness: { ready: true, blockedReason: null },
    sampleGate: {
      distinctTaskCount: shadow.distinctTaskCount,
      sufficientSampleSize: shadow.sufficientSampleSize,
    },
    agreementGate: {
      topOneAgreementRate: shadow.topOneAgreementRate,
      meetsThreshold: shadow.meetsAgreementThreshold,
    },
    effectGate: {
      candidateConcordance: effect.candidateConcordance,
      productionConcordance: effect.productionConcordance,
      pairCount: effect.pairCount,
      sufficientData: effect.sufficientData,
      notRegressed,
    },
    stabilityGate: {
      p95LatencyMs: stability.p95LatencyMs,
      errorOrTimeoutRate: stability.errorOrTimeoutRate,
      hasData: stability.hasData,
      meetsLatencyThreshold: stability.meetsLatencyThreshold,
      meetsErrorRateThreshold: stability.meetsErrorRateThreshold,
    },
    eligibleForAdvancement: blockedReasons.length === 0,
    blockedReasons,
  };
}

export async function getCurrentReleaseStage(client: Queryable): Promise<ReleaseStage> {
  const { rows } = await client.query<{ stage: ReleaseStage }>(
    `SELECT stage FROM release_stage_state WHERE id = true`,
  );
  const stage = rows[0]?.stage;
  if (!stage) {
    throw new Error(
      "release_stage_state: singleton row missing — has migration 0039_create_release_stage.sql been applied?",
    );
  }
  return stage;
}

function nextStage(current: ReleaseStage): ReleaseStage | null {
  const index = STAGE_ORDER.indexOf(current);
  return index >= 0 && index < STAGE_ORDER.length - 1 ? (STAGE_ORDER[index + 1] ?? null) : null;
}

async function insertAuditLog(
  client: Queryable,
  input: {
    fromStage: ReleaseStage;
    toStage: ReleaseStage;
    action: "ADVANCE" | "ROLLBACK";
    triggeredBy: string;
    reason: string;
    gateSnapshot: ReleaseGateSnapshot | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO release_stage_audit_logs
       (from_stage, to_stage, action, triggered_by, reason, gate_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.fromStage,
      input.toStage,
      input.action,
      input.triggeredBy,
      input.reason,
      JSON.stringify(input.gateSnapshot ?? {}),
    ],
  );
}

export interface AdvanceReleaseStageResult {
  advanced: boolean;
  fromStage: ReleaseStage;
  toStage: ReleaseStage | null;
  blockedReasons: string[];
  gate: ReleaseGateSnapshot | null;
}

/**
 * F-1916's own literal requirement: "任何一次从上一阶段推进到下一阶段都需
 * 要人工批准" — `approvedBy` is a real caller-supplied identity (mirrors
 * `runPromote`'s explicit-invocation-by-a-human convention, T-1905), never
 * inferred or defaulted. Re-evaluates the gate FRESH inside the same
 * transaction that holds the singleton row lock — a stage change and the
 * gate snapshot that justified it are one atomic, auditable unit; a
 * concurrent advance/rollback attempt blocks on the row lock rather than
 * racing to a nonsensical intermediate state. Advances exactly ONE stage
 * per call (SHADOW→GRADUAL or GRADUAL→PRIMARY) — F-1916's "不允许跨级"
 * requirement — never SHADOW→PRIMARY directly regardless of how far past
 * every threshold the real numbers are.
 */
export async function advanceReleaseStage(
  pool: Pool,
  input: { approvedBy: string; reason: string },
): Promise<AdvanceReleaseStageResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ stage: ReleaseStage }>(
      `SELECT stage FROM release_stage_state WHERE id = true FOR UPDATE`,
    );
    const fromStage = rows[0]?.stage;
    if (!fromStage) {
      throw new Error(
        "release_stage_state: singleton row missing — has migration 0039_create_release_stage.sql been applied?",
      );
    }

    const target = nextStage(fromStage);
    if (!target) {
      await client.query("ROLLBACK");
      return {
        advanced: false,
        fromStage,
        toStage: null,
        blockedReasons: ["已处于 PRIMARY，没有更高阶段可以推进"],
        gate: null,
      };
    }

    // N4 P2 fix (round 1): evaluated through the SAME checked-out `client`
    // that already holds the singleton row's `FOR UPDATE` lock — never the
    // bare `pool` — see `evaluateReleaseGate`'s own doc comment for the
    // pool-exhaustion deadlock this avoids.
    const gate = await evaluateReleaseGate(client);
    if (!gate.eligibleForAdvancement) {
      await client.query("ROLLBACK");
      return {
        advanced: false,
        fromStage,
        toStage: target,
        blockedReasons: gate.blockedReasons,
        gate,
      };
    }

    await client.query(
      `UPDATE release_stage_state SET stage = $1, updated_at = now() WHERE id = true`,
      [target],
    );
    await insertAuditLog(client, {
      fromStage,
      toStage: target,
      action: "ADVANCE",
      triggeredBy: `human:${input.approvedBy}`,
      reason: input.reason,
      gateSnapshot: gate,
    });
    await client.query("COMMIT");

    return { advanced: true, fromStage, toStage: target, blockedReasons: [], gate };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface AutoRollbackResult {
  rolledBack: boolean;
  fromStage: ReleaseStage;
  toStage: ReleaseStage;
  blockedReasons: string[];
  gate: ReleaseGateSnapshot;
}

/**
 * 用户 2026-09-06 决策: 自动回滚机制，无需人工批准（回滚是安全方向的降级，
 * 不是推进）。Rolls all the way back to `SHADOW` (never a one-step-back
 * partial rollback: GRADUAL/PRIMARY's own gate re-check failing means the
 * evidence that justified being past SHADOW at all is no longer valid —
 * the only genuinely safe state is the one that adopts nothing). A no-op
 * (no audit row written) when the current stage is already `SHADOW`, or
 * when the current stage's gate re-check still passes — this function is
 * meant to be invoked periodically (a cron-style CLI, mirroring T-1905's
 * own script convention) and must not spam the audit log on every healthy
 * check.
 */
export async function checkAndAutoRollback(pool: Pool): Promise<AutoRollbackResult | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ stage: ReleaseStage }>(
      `SELECT stage FROM release_stage_state WHERE id = true FOR UPDATE`,
    );
    const fromStage = rows[0]?.stage;
    if (!fromStage) {
      throw new Error(
        "release_stage_state: singleton row missing — has migration 0039_create_release_stage.sql been applied?",
      );
    }

    if (fromStage === "SHADOW") {
      await client.query("ROLLBACK");
      return null;
    }

    // N4 P2 fix (round 1): same reasoning as `advanceReleaseStage` above —
    // evaluated through the locked `client`, never the bare `pool`.
    const gate = await evaluateReleaseGate(client);
    if (gate.eligibleForAdvancement) {
      // Still healthy — no action, no audit noise.
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `UPDATE release_stage_state SET stage = 'SHADOW', updated_at = now() WHERE id = true`,
    );
    await insertAuditLog(client, {
      fromStage,
      toStage: "SHADOW",
      action: "ROLLBACK",
      triggeredBy: "system:auto-rollback",
      reason: `门槛复检未通过：${gate.blockedReasons.join("；")}`,
      gateSnapshot: gate,
    });
    await client.query("COMMIT");

    return {
      rolledBack: true,
      fromStage,
      toStage: "SHADOW",
      blockedReasons: gate.blockedReasons,
      gate,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
