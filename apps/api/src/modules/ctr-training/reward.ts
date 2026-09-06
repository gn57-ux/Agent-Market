import type { TrainingExampleRow } from "./dataset-builder.js";

/**
 * design.md 决策 6's own composite-label definition, made concrete (the
 * design doc explicitly defers the exact weighting to "训练脚本的实现细节，
 * 需在 T-1905 落地时以离线指标验证" — this IS that落地):
 *
 *   EXPOSURE → ACCEPT（粗粒度选中信号，+1）
 *   叠加 APPROVE/RATE（交付质量，正向）与 DISPUTE/REFUND（负向）
 *
 * A candidate that was never accepted (F-1906's exposure-censoring records
 * — kept for future bias analysis, Q-1904) contributes a neutral `0`: not
 * being selected isn't evidence the candidate was BAD, only that it wasn't
 * chosen — treating it as a negative would bias the label toward whatever
 * the OLD ranking already preferred (exactly the kind of feedback loop
 * F-1905/F-1906's own risk notes warn about).
 *
 * An accepted candidate whose task ended in `CANCELLED` (accepted, but the
 * task was called off before any outcome could be recorded) is treated as
 * a mild negative: the selection produced no positive result, but this is
 * a real, distinct failure mode from a REFUND/DISPUTE (adversarial/quality
 * failure) or a rating (an explicit human quality judgment), so it carries
 * a smaller magnitude than either.
 *
 * `ratingScore` (1-5) is centered on 3 (neutral) and scaled to roughly
 * [-1, 1] so it doesn't dominate the coarser +1/-1 signals purely by having
 * a wider native range.
 */
export function computeReward(example: TrainingExampleRow): number {
  if (!example.wasAccepted) return 0;

  let reward = 1; // being selected at all is itself a coarse positive signal.

  if (example.outcome?.approved) reward += 1;
  if (example.outcome?.ratingScore != null) {
    reward += (example.outcome.ratingScore - 3) / 2;
  }
  if (example.outcome?.refunded) reward -= 1.5;
  if (example.outcome?.disputed) reward -= 1.5;
  if (!example.outcome?.approved && example.taskTerminalStatus === "CANCELLED") {
    reward -= 0.5;
  }

  return reward;
}
