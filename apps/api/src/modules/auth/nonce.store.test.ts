import { describe, expect, it } from "vitest";
import { InvalidAddressError, normalizeAddress } from "./nonce.store.js";

// Pure unit tests — no database required. `issueNonce`/`consumeNonce`
// integration coverage lives in nonce.store.integration.test.ts, gated
// behind RUN_DB_INTEGRATION_TESTS (see that file's header comment for why).
describe("normalizeAddress", () => {
  it("lowercases a mixed-case address", () => {
    const mixedCase = "0x4283FeFc63F0Cd0e873a0000C6D07eF7B77e90D3";
    expect(normalizeAddress(mixedCase)).toBe(mixedCase.toLowerCase());
  });

  it("two differently-cased inputs normalize to the same value", () => {
    const upper = "0x4283FEFC63F0CD0E873A0000C6D07EF7B77E90D3";
    const lower = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
    expect(normalizeAddress(upper)).toBe(normalizeAddress(lower));
  });

  it("rejects a string that is not a 20-byte hex address", () => {
    expect(() => normalizeAddress("not-an-address")).toThrow(InvalidAddressError);
    expect(() => normalizeAddress("0x123")).toThrow(InvalidAddressError);
    // 41 hex chars instead of 40
    expect(() => normalizeAddress("0x4283FeFc63F0Cd0e873a0000C6D07eF7B77e90D33")).toThrow(
      InvalidAddressError,
    );
  });
});
