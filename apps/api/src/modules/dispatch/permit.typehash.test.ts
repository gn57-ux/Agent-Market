import { describe, expect, it } from "vitest";
import { ACCEPTANCE_PERMIT_TYPES } from "./permit.service.js";

/**
 * T-706 capsule's explicit drift-detection test: if a future edit to either
 * `contracts/src/TaskEscrow.sol`'s `ACCEPTANCE_PERMIT_TYPEHASH` string or
 * `permit.service.ts`'s `ACCEPTANCE_PERMIT_TYPES` changes a field name,
 * type, or order without updating the other, every permit this module
 * issues would recover a signer address on-chain that doesn't match
 * `authorizedSigner`, and `acceptTask` would reject every one of them with
 * `InvalidPermitSignature` — silently, with no test failure anywhere else
 * to catch it. This test hardcodes the contract's typehash literal (copied
 * verbatim from TaskEscrow.sol) and asserts this module's type definition
 * reconstructs the identical EIP-712 type string, character for character.
 */
describe("ACCEPTANCE_PERMIT_TYPES matches TaskEscrow.sol's ACCEPTANCE_PERMIT_TYPEHASH (T-706)", () => {
  const CONTRACT_TYPEHASH_STRING =
    "AcceptancePermit(bytes32 taskId,address agent,uint256 nonce,uint256 expiry,uint256 chainId,address verifyingContract)";

  it("reconstructs the exact typehash string from ACCEPTANCE_PERMIT_TYPES's field name/type/order", () => {
    const fields = ACCEPTANCE_PERMIT_TYPES.AcceptancePermit;
    const reconstructed = `AcceptancePermit(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;

    expect(reconstructed).toBe(CONTRACT_TYPEHASH_STRING);
  });

  it("has exactly the six fields the contract struct declares, in the contract's declared order", () => {
    expect(ACCEPTANCE_PERMIT_TYPES.AcceptancePermit).toEqual([
      { name: "taskId", type: "bytes32" },
      { name: "agent", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
  });
});
