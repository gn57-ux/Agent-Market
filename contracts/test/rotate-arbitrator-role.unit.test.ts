import { expect } from "chai";
import { normalizeAndValidateRotationAddresses } from "../scripts/rotate-arbitrator-role";

/**
 * Feature 21 (arbitration-committee), T-2104. N4 real finding (P1, round
 * 1): the rotation script's own address normalization/same-address guard
 * had no dedicated test. A pure-function unit test (no Hardhat network
 * needed) directly against the exported function this script's own
 * on-chain logic depends on.
 */
describe("normalizeAndValidateRotationAddresses (T-2104, N4 P1 fix)", () => {
  const EOA_MIXED_CASE = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const SAFE_MIXED_CASE = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("normalizes real EIP-55 mixed-case addresses to lowercase (matching arbitration_upgrade_log's own DB-level format constraint)", () => {
    const result = normalizeAndValidateRotationAddresses(SAFE_MIXED_CASE, EOA_MIXED_CASE);
    expect(result.newArbitratorAddress).to.equal(SAFE_MIXED_CASE.toLowerCase());
    expect(result.oldArbitratorAddress).to.equal(EOA_MIXED_CASE.toLowerCase());
    expect(result.newArbitratorAddress).to.match(/^0x[0-9a-f]{40}$/);
    expect(result.oldArbitratorAddress).to.match(/^0x[0-9a-f]{40}$/);
  });

  it("rejects rotating to the same address it rotates from — even when the two inputs differ only by case", () => {
    expect(() =>
      normalizeAndValidateRotationAddresses(EOA_MIXED_CASE, EOA_MIXED_CASE.toLowerCase()),
    ).to.throw(/must be different/);
  });

  it("rejects a malformed address input (real ethers.getAddress checksum/format validation, not re-implemented here)", () => {
    expect(() =>
      normalizeAndValidateRotationAddresses("not-an-address", EOA_MIXED_CASE),
    ).to.throw();
  });
});
