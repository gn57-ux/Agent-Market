import type { ReputationSignalsDigest } from "../dispatch/reputation-signals.js";

/**
 * The five weight coefficients a trained `ranking_policy_version` produces
 * (design.md 决策 6: "仅调五维融合权重") — same five keys as Go's `ScoreV2`
 * (`services/dispatch/internal/scoring/scoring.go`) and Python's
 * `fusion.py`'s `DEFAULT_WEIGHTS`, never a sixth key or a renamed one:
 * this training script tunes the SAME formula's coefficients, it does not
 * introduce a new one (F-1909's own "只把融合这一步从固定公式改为可推理编排"
 * boundary).
 */
export interface FusionWeights {
  completionRate: number;
  qualityFeedback: number;
  communication: number;
  disputeSignal: number;
  historicalScale: number;
}

/**
 * Go's `ScoreV2`/Python's `fusion.py` fixed starting point — every training
 * run's grid search includes this exact vector as one candidate, so a
 * dataset too small/uninformative to beat it honestly reports "no
 * improvement found" instead of drifting away from a known-good baseline
 * for no real reason.
 */
export const DEFAULT_FUSION_WEIGHTS: FusionWeights = {
  completionRate: 0.3,
  qualityFeedback: 0.3,
  communication: 0.15,
  disputeSignal: 0.2,
  historicalScale: 0.05,
};

const SIGNAL_KEYS = [
  "completionRate",
  "qualityFeedback",
  "communication",
  "disputeSignal",
  "historicalScale",
] as const;

/**
 * Mirrors Go's `ScoreV2`/Python's `fusion.py` EXACTLY (not an independently
 * invented formula, same reasoning as T-1911's own `fusion.py`): weighted
 * average over only the PRESENT signals, renormalized by the sum of their
 * own weights, rounded to 6 decimals; a candidate with no signals at all
 * (or a `null` digest — a `v0.1` run's candidates never persist one) scores
 * `0`. The training script needs its OWN copy of this formula (not
 * importable from Go/Python) to evaluate a candidate weight vector against
 * historical examples entirely in-process.
 */
export function computeFusedScore(
  signals: ReputationSignalsDigest | null,
  weights: FusionWeights,
): number {
  if (!signals) return 0;

  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of SIGNAL_KEYS) {
    const value = signals[key].value;
    if (value === null) continue;
    weightedSum += value * weights[key];
    weightTotal += weights[key];
  }

  if (weightTotal === 0) return 0;
  return Math.round((weightedSum / weightTotal) * 1_000_000) / 1_000_000;
}
