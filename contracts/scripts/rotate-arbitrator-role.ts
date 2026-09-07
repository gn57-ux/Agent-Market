import { ethers, network } from "hardhat";

/**
 * Feature 21 (arbitration-committee), T-2104 (F-2113 升级方案，步骤 2).
 *
 * A real, standalone Hardhat script (same convention as `deploy-local.ts`)
 * that performs the actual on-chain `ARBITRATOR_ROLE` rotation: grants the
 * role to the new holder (a deployed Safe's address, T-2103), then revokes
 * it from the old holder. Both calls must be made by an account already
 * holding `DEFAULT_ADMIN_ROLE` on the target `TaskEscrow` — the deployer
 * account at construction time (`TaskEscrow.sol`'s own constructor).
 *
 * Deliberately does NOT touch the database itself — `arbitration_upgrade_
 * log`'s real row is written by `apps/api`'s own repository
 * (`upgrade-log-repository.ts`), using the real addresses and real tx
 * hash this script prints, matching this project's existing split
 * between "the contracts package can sign and send real transactions"
 * and "apps/api owns all Postgres writes" (no cross-package DB client
 * dependency introduced here).
 *
 * Required env vars:
 *   TASK_ESCROW_ADDRESS   — the deployed TaskEscrow contract
 *   NEW_ARBITRATOR_ADDRESS — the address to grant ARBITRATOR_ROLE to
 *   OLD_ARBITRATOR_ADDRESS — the address to revoke ARBITRATOR_ROLE from
 *
 * Run as:
 *   TASK_ESCROW_ADDRESS=... NEW_ARBITRATOR_ADDRESS=... OLD_ARBITRATOR_ADDRESS=... \
 *     npx hardhat run scripts/rotate-arbitrator-role.ts --network localhost
 */
/**
 * N4 real finding (P1, round 1, T-2104): extracted as a pure, exported
 * function specifically so it can be unit tested WITHOUT spinning up
 * Hardhat's full runtime (this file's only export not gated behind the
 * top-level `rotateArbitratorRole()` call, which needs a real network) —
 * see `rotate-arbitrator-role.unit.test.ts`, added directly in response
 * to this same review round's own request for "对应测试".
 *
 * Two real, distinct defects this validates against:
 * 1. `arbitration_upgrade_log`'s own CHECK constraint
 *    (`0040_create_arbitration_committee_tables.sql`) only accepts
 *    lowercase hex addresses, but a real caller's env var (or a Hardhat
 *    signer's own EIP-55 mixed-case `.address`) is not guaranteed to
 *    already be lowercase — printing the raw, unnormalized value would
 *    make the very audit-log write this rotation exists to enable fail
 *    at the database boundary on a real run.
 * 2. A rotation "to" the SAME address it's rotating "from" would pass
 *    every later check (the old address genuinely holds the role,
 *    `grantRole` on an address that already has it is a real no-op
 *    success) right up until `revokeRole` removes the only real holder
 *    of `ARBITRATOR_ROLE`, leaving the contract with zero arbitrators.
 * 3. (round 2) The zero address can never be a real, usable arbitrator —
 *    `grantRole`/`revokeRole` would both succeed on it (AccessControl
 *    itself does not special-case `address(0)`), silently leaving
 *    `TaskEscrow` with zero arbitrators without the round-1
 *    same-address guard ever triggering.
 */
export function normalizeAndValidateRotationAddresses(
  newArbitratorAddressRaw: string,
  oldArbitratorAddressRaw: string,
): { newArbitratorAddress: string; oldArbitratorAddress: string } {
  const newArbitratorAddress = ethers.getAddress(newArbitratorAddressRaw).toLowerCase();
  const oldArbitratorAddress = ethers.getAddress(oldArbitratorAddressRaw).toLowerCase();
  if (newArbitratorAddress === ethers.ZeroAddress.toLowerCase()) {
    throw new Error(
      "rotate-arbitrator-role: NEW_ARBITRATOR_ADDRESS cannot be the zero address — TaskEscrow would be left with no usable arbitrator.",
    );
  }
  if (newArbitratorAddress === oldArbitratorAddress) {
    throw new Error(
      "rotate-arbitrator-role: NEW_ARBITRATOR_ADDRESS and OLD_ARBITRATOR_ADDRESS must be different — rotating to the same address would leave TaskEscrow with zero real arbitrators after revokeRole.",
    );
  }
  return { newArbitratorAddress, oldArbitratorAddress };
}

export async function rotateArbitratorRole(): Promise<void> {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error(
      `Arbitrator role rotation refuses network ${network.name} — this repo's own decided ` +
        `environment scope (requirements.md v1.2) is a real local Hardhat node, never a public ` +
        `testnet or mainnet, until that is a separately authorized, later decision.`,
    );
  }

  const taskEscrowAddress = process.env.TASK_ESCROW_ADDRESS;
  const newArbitratorAddressRaw = process.env.NEW_ARBITRATOR_ADDRESS;
  const oldArbitratorAddressRaw = process.env.OLD_ARBITRATOR_ADDRESS;
  if (!taskEscrowAddress || !newArbitratorAddressRaw || !oldArbitratorAddressRaw) {
    throw new Error(
      "rotate-arbitrator-role: TASK_ESCROW_ADDRESS, NEW_ARBITRATOR_ADDRESS, and OLD_ARBITRATOR_ADDRESS are all required.",
    );
  }

  const { newArbitratorAddress, oldArbitratorAddress } = normalizeAndValidateRotationAddresses(
    newArbitratorAddressRaw,
    oldArbitratorAddressRaw,
  );

  // N4 real finding (P1, round 2, T-2104): neither the format check nor
  // the zero-address/same-address guards above can catch a syntactically
  // valid but WRONG address — a mistyped EOA, or an address that is
  // simply not the Safe the operator actually deployed in T-2103. This
  // script serves BOTH a forward rotation (single EOA -> Safe, the real
  // multisig contract MUST have on-chain bytecode) and T-2109's later
  // reverse rotation (Safe -> single EOA, the real rollback target is
  // deliberately an EOA with NO bytecode) — the two cases have opposite
  // expectations, so the caller must say which one this run is
  // (`ROTATION_MODE=forward|rollback`) rather than this script silently
  // guessing from bytecode alone.
  const rotationMode = process.env.ROTATION_MODE;
  if (rotationMode !== "forward" && rotationMode !== "rollback") {
    throw new Error(
      "rotate-arbitrator-role: ROTATION_MODE must be set to exactly 'forward' or 'rollback' — this determines whether NEW_ARBITRATOR_ADDRESS is expected to be a real deployed Safe (forward) or a real EOA (rollback).",
    );
  }
  const newArbitratorCode = await ethers.provider.getCode(newArbitratorAddress);
  const newArbitratorHasCode = newArbitratorCode !== "0x";
  if (rotationMode === "forward" && !newArbitratorHasCode) {
    throw new Error(
      `rotate-arbitrator-role: ROTATION_MODE=forward requires NEW_ARBITRATOR_ADDRESS (${newArbitratorAddress}) to be a real deployed contract (the Safe from T-2103) — it currently has no on-chain bytecode, so this is very likely a mistyped or wrong address, not the intended Safe.`,
    );
  }
  if (rotationMode === "rollback" && newArbitratorHasCode) {
    throw new Error(
      `rotate-arbitrator-role: ROTATION_MODE=rollback requires NEW_ARBITRATOR_ADDRESS (${newArbitratorAddress}) to be a real EOA (the pre-Safe single arbitrator) — it currently has on-chain bytecode, so this looks like a Safe or another contract, not the intended rollback target.`,
    );
  }

  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("Hardhat did not provide a local admin account.");
  const actorAddress = admin.address.toLowerCase();

  const escrow = await ethers.getContractAt("TaskEscrow", taskEscrowAddress, admin);
  const arbitratorRole = await escrow.ARBITRATOR_ROLE();

  const hasOldRole = await escrow.hasRole(arbitratorRole, oldArbitratorAddress);
  if (!hasOldRole) {
    throw new Error(
      `rotate-arbitrator-role: ${oldArbitratorAddress} does not currently hold ARBITRATOR_ROLE — refusing to proceed with a rotation that does not match the real on-chain state.`,
    );
  }

  const grantTx = await escrow.grantRole(arbitratorRole, newArbitratorAddress);
  const grantReceipt = await grantTx.wait();
  if (!grantReceipt) throw new Error("grantRole produced no receipt");

  const revokeTx = await escrow.revokeRole(arbitratorRole, oldArbitratorAddress);
  const revokeReceipt = await revokeTx.wait();
  if (!revokeReceipt) throw new Error("revokeRole produced no receipt");

  const newHasRole = await escrow.hasRole(arbitratorRole, newArbitratorAddress);
  const oldStillHasRole = await escrow.hasRole(arbitratorRole, oldArbitratorAddress);
  if (!newHasRole || oldStillHasRole) {
    throw new Error(
      "rotate-arbitrator-role: post-rotation on-chain state does not match the expected outcome — refusing to report success.",
    );
  }

  console.log("ARBITRATOR_ROLE rotation complete.");
  console.log(`ACTOR_ADDRESS=${actorAddress}`);
  console.log(`FROM_ARBITRATOR_ADDRESS=${oldArbitratorAddress}`);
  console.log(`TO_ARBITRATOR_ADDRESS=${newArbitratorAddress}`);
  console.log(`GRANT_TX_HASH=${grantTx.hash.toLowerCase()}`);
  console.log(`REVOKE_TX_HASH=${revokeTx.hash.toLowerCase()}`);
}

// Only auto-run when invoked directly (`npx hardhat run ...`) — guarded so
// `rotate-arbitrator-role.unit.test.ts` can import
// `normalizeAndValidateRotationAddresses` from this same file without
// also triggering a real (and, absent real env vars, immediately failing)
// network call as an import side effect.
if (require.main === module) {
  rotateArbitratorRole().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
