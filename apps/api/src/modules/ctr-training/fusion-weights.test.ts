import { describe, expect, it } from "vitest";
import { computeFusedScore, DEFAULT_FUSION_WEIGHTS } from "./fusion-weights.js";
import type { ReputationSignalsDigest } from "../dispatch/reputation-signals.js";

function entry(value: number | null): { value: number | null; sampleSize: number } {
  return { value, sampleSize: value === null ? 0 : 5 };
}

const FULL_SIGNALS: ReputationSignalsDigest = {
  completionRate: entry(1),
  qualityFeedback: entry(1),
  communication: entry(1),
  disputeSignal: entry(1),
  historicalScale: entry(1),
};

describe("computeFusedScore", () => {
  it("returns 0 for a null digest (v0.1 run, no persisted signals)", () => {
    expect(computeFusedScore(null, DEFAULT_FUSION_WEIGHTS)).toBe(0);
  });

  it("returns the weighted average when every signal is present", () => {
    // All signals = 1, so the weighted average is 1 regardless of weights.
    expect(computeFusedScore(FULL_SIGNALS, DEFAULT_FUSION_WEIGHTS)).toBe(1);
  });

  it("renormalizes over only the present signals, mirroring Go's ScoreV2", () => {
    const partial: ReputationSignalsDigest = {
      ...FULL_SIGNALS,
      completionRate: entry(null),
      qualityFeedback: entry(null),
    };
    // Only communication(0.15)/disputeSignal(0.20)/historicalScale(0.05) present,
    // all valued at 1 -> renormalized weighted average is still 1.
    expect(computeFusedScore(partial, DEFAULT_FUSION_WEIGHTS)).toBe(1);
  });

  it("returns 0 when every signal is missing (weightTotal is 0)", () => {
    const allMissing: ReputationSignalsDigest = {
      completionRate: entry(null),
      qualityFeedback: entry(null),
      communication: entry(null),
      disputeSignal: entry(null),
      historicalScale: entry(null),
    };
    expect(computeFusedScore(allMissing, DEFAULT_FUSION_WEIGHTS)).toBe(0);
  });

  it("weights signals proportionally when values differ", () => {
    const mixed: ReputationSignalsDigest = {
      completionRate: entry(1), // weight 0.30
      qualityFeedback: entry(0), // weight 0.30
      communication: entry(0), // weight 0.15
      disputeSignal: entry(0), // weight 0.20
      historicalScale: entry(0), // weight 0.05
    };
    // Weighted sum = 1*0.30 = 0.30, weight total = 1 -> 0.30.
    expect(computeFusedScore(mixed, DEFAULT_FUSION_WEIGHTS)).toBe(0.3);
  });
});
