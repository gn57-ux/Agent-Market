import { describe, expect, it } from "vitest";
import { aggregateQualityScore } from "./service.js";

describe("aggregateQualityScore", () => {
  it("returns null (not 0) for an empty input — AC-1010: no scores means no score, not a placeholder", () => {
    expect(aggregateQualityScore([])).toBeNull();
  });

  it("maps a single score of 1 to 0.0", () => {
    expect(aggregateQualityScore([1])).toBe(0);
  });

  it("maps a single score of 5 to 1.0", () => {
    expect(aggregateQualityScore([5])).toBe(1);
  });

  it("maps a single score of 3 to the midpoint 0.5", () => {
    expect(aggregateQualityScore([3])).toBe(0.5);
  });

  it("normalizes the mean of several real scores", () => {
    // mean = 4, normalized = (4-1)/4 = 0.75
    expect(aggregateQualityScore([5, 4, 3])).toBeCloseTo(0.75, 10);
  });

  it("is equivalent to averaging each individually-normalized score", () => {
    const scores = [2, 5, 1, 4];
    const viaMean = aggregateQualityScore(scores);
    const viaIndividual = scores.reduce((sum, s) => sum + (s - 1) / 4, 0) / scores.length;
    expect(viaMean).toBeCloseTo(viaIndividual, 10);
  });
});
