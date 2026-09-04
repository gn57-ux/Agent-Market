import { describe, expect, it } from "vitest";
import { computeRetryDelayMs } from "./indexer.js";

/**
 * F-1812 / AC-1808 (T-1808): pure-function coverage for the backoff
 * formula `main.ts`'s own loop uses on consecutive tick failures.
 */
describe("computeRetryDelayMs", () => {
  it("returns the base interval when there have been no failures yet", () => {
    expect(computeRetryDelayMs(5_000, 0, 60_000)).toBe(5_000);
  });

  it("doubles the delay on each consecutive failure", () => {
    expect(computeRetryDelayMs(5_000, 1, 60_000)).toBe(10_000);
    expect(computeRetryDelayMs(5_000, 2, 60_000)).toBe(20_000);
    expect(computeRetryDelayMs(5_000, 3, 60_000)).toBe(40_000);
  });

  it("caps the delay at maxDelayMs instead of growing unbounded", () => {
    expect(computeRetryDelayMs(5_000, 10, 60_000)).toBe(60_000);
    expect(computeRetryDelayMs(5_000, 100, 60_000)).toBe(60_000);
  });

  it("treats a negative failure count the same as zero (defensive, not expected in real use)", () => {
    expect(computeRetryDelayMs(5_000, -1, 60_000)).toBe(5_000);
  });
});
