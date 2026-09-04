import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIRMATION_DEPTH, resolveConfirmationDepth } from "./env.js";

/**
 * T-1806 round 2 (N4 real P2 fix regression): `resolveConfirmationDepth`
 * must reject a negative `INDEXER_CONFIRMATION_DEPTH` rather than silently
 * accepting it — a negative depth makes `confirmIndexedEvents`'s own
 * `latestBlock - confirmationDepth` arithmetic land above the current tip,
 * immediately confirming every pending row regardless of real confirmation
 * count.
 */
describe("resolveConfirmationDepth", () => {
  it("returns the documented default when INDEXER_CONFIRMATION_DEPTH is unset", () => {
    expect(resolveConfirmationDepth({})).toBe(DEFAULT_CONFIRMATION_DEPTH);
  });

  it("returns the configured value when it is a valid non-negative integer", () => {
    expect(resolveConfirmationDepth({ INDEXER_CONFIRMATION_DEPTH: "5" })).toBe(5n);
    expect(resolveConfirmationDepth({ INDEXER_CONFIRMATION_DEPTH: "0" })).toBe(0n);
  });

  it("rejects a negative confirmation depth instead of silently bypassing the confirmation window", () => {
    expect(() => resolveConfirmationDepth({ INDEXER_CONFIRMATION_DEPTH: "-1" })).toThrow(
      /non-negative/,
    );
  });
});
