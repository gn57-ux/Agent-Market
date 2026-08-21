import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/amount.js";

// Boundary-value coverage for bigint parsing/formatting only.
// Deliberately does NOT test any staking/fee formula — that calculation
// is owned exclusively by the TaskEscrow contract (Feature 2); this module
// only converts between human decimal strings and minimal-unit bigints.
describe("Amount parse/format (18 decimals)", () => {
  it("round-trips zero", () => {
    expect(parseAmount("0")).toBe(0n);
    expect(formatAmount(0n)).toBe("0");
  });

  it("round-trips the smallest unit (1 wei-equivalent)", () => {
    expect(parseAmount("0.000000000000000001")).toBe(1n);
    expect(formatAmount(1n)).toBe("0.000000000000000001");
  });

  it("round-trips a whole-token amount", () => {
    expect(parseAmount("100")).toBe(100_000000000000000000n);
    expect(formatAmount(100_000000000000000000n)).toBe("100");
  });

  it("round-trips a very large amount (near uint256 max)", () => {
    const uint256Max = 2n ** 256n - 1n;
    expect(formatAmount(uint256Max)).toMatch(/^\d+\.\d+$/);
    expect(parseAmount(formatAmount(uint256Max))).toBe(uint256Max);
  });

  it("supports a non-default decimals count (e.g. a 6-decimal token)", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500000n);
    expect(formatAmount(1_500000n, 6)).toBe("1.5");
  });

  it("rejects a malformed decimal string", () => {
    expect(() => parseAmount("not-a-number")).toThrow();
  });
});
