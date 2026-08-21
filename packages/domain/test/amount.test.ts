import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/amount.js";

// Boundary-value coverage for bigint parsing/formatting only.
// Deliberately does NOT test any staking/fee formula — that calculation
// is owned exclusively by the TaskEscrow contract (Feature 2); this module
// only converts between human decimal strings and minimal-unit bigints.
// Derived from `10n ** BigInt(decimals)` rather than long literal digit
// runs, both for readability and to avoid magic numbers.
const ONE_TOKEN_18 = 10n ** 18n;
const ONE_TOKEN_6 = 10n ** 6n;

describe("Amount parse/format (18 decimals)", () => {
  it("round-trips zero", () => {
    expect(parseAmount("0")).toBe(0n);
    expect(formatAmount(0n)).toBe("0");
  });

  it("round-trips the smallest unit (1 wei-equivalent)", () => {
    const smallestUnit = 1n;
    const asDecimalString = formatAmount(smallestUnit);
    expect(parseAmount(asDecimalString)).toBe(smallestUnit);
    expect(asDecimalString.endsWith("1")).toBe(true);
  });

  it("round-trips a whole-token amount", () => {
    const oneHundredTokens = ONE_TOKEN_18 * 100n;
    expect(parseAmount("100")).toBe(oneHundredTokens);
    expect(formatAmount(oneHundredTokens)).toBe("100");
  });

  it("round-trips a very large amount (near uint256 max)", () => {
    const uint256Max = 2n ** 256n - 1n;
    expect(formatAmount(uint256Max)).toMatch(/^\d+\.\d+$/);
    expect(parseAmount(formatAmount(uint256Max))).toBe(uint256Max);
  });

  it("supports a non-default decimals count (e.g. a 6-decimal token)", () => {
    const oneAndAHalf = ONE_TOKEN_6 + ONE_TOKEN_6 / 2n;
    expect(parseAmount("1.5", 6)).toBe(oneAndAHalf);
    expect(formatAmount(oneAndAHalf, 6)).toBe("1.5");
  });

  it("rejects a malformed decimal string", () => {
    expect(() => parseAmount("not-a-number")).toThrow();
  });

  it("rejects negative amounts instead of silently wrapping them", () => {
    expect(() => parseAmount("-1")).toThrow(/negative/);
  });

  it("rejects input with more fractional digits than the token's decimals instead of silently rounding", () => {
    const oneExtraDigit = `0.${"0".repeat(18)}9`; // 19 fractional digits, 1 more than DEFAULT_DECIMALS
    const atTheBoundary = `0.${"0".repeat(17)}1`; // exactly 18 fractional digits
    expect(() => parseAmount(oneExtraDigit)).toThrow(/fractional digits/);
    expect(() => parseAmount(atTheBoundary)).not.toThrow();
  });
});
