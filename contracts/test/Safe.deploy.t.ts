import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployRealSafe } from "./helpers/safe";

/**
 * Feature 21 (arbitration-committee), T-2103 (F-2112/F-2113, design.md
 * v1.1 方案 B 决策，用户 2026-09-06 环境范围决策）.
 *
 * Real deployment (not mocked, not stubbed) of the OFFICIAL, UNMODIFIED
 * `@safe-global/safe-contracts@1.4.1` `Safe`/`SafeProxyFactory` contracts
 * on this project's own real local Hardhat network — 3 independent test
 * signer addresses as owners, 2/3 threshold, matching requirements.md
 * v1.1's decided committee size exactly. This is deliberately the
 * project's real local Hardhat network (the same one every other
 * `contracts/test/*.t.ts` file already runs against via `npx hardhat
 * test`), NOT a public testnet (Sepolia etc.) — a public testnet
 * deployment would need real RPC access, real testnet funds, and
 * dedicated signer key management this repo does not have configured
 * and which is explicitly out of this Task's scope (requirements.md
 * AC-2103's own v1.2 environment-scope note).
 */
describe("Real Gnosis Safe deployment (T-2103, AC-2103 前半)", () => {
  let owner1: HardhatEthersSigner;
  let owner2: HardhatEthersSigner;
  let owner3: HardhatEthersSigner;
  let nonOwner: HardhatEthersSigner;

  beforeEach(async () => {
    [, owner1, owner2, owner3, nonOwner] = await ethers.getSigners();
  });

  it("deploys a real Safe proxy whose own on-chain owners()/getThreshold() match the decided 3-owner/2-threshold committee", async () => {
    const safe = await deployRealSafe([owner1.address, owner2.address, owner3.address], 2);

    const onChainOwners = await safe.getOwners();
    expect(onChainOwners.map((a) => a.toLowerCase()).sort()).to.deep.equal(
      [owner1.address, owner2.address, owner3.address].map((a) => a.toLowerCase()).sort(),
    );
    expect(await safe.getThreshold()).to.equal(2n);

    // `isOwner` is the real Safe contract's own authority on membership —
    // not something this Feature re-derives independently.
    expect(await safe.isOwner(owner1.address)).to.equal(true);
    expect(await safe.isOwner(nonOwner.address)).to.equal(false);
  });

  it("two independently deployed Safes (different owner sets) never collide on address or share state", async () => {
    const safeA = await deployRealSafe([owner1.address, owner2.address, owner3.address], 2);
    const safeB = await deployRealSafe([owner1.address, nonOwner.address, owner3.address], 2);

    expect(await safeA.getAddress()).to.not.equal(await safeB.getAddress());
    expect(await safeA.isOwner(owner2.address)).to.equal(true);
    expect(await safeA.isOwner(nonOwner.address)).to.equal(false);
    expect(await safeB.isOwner(owner2.address)).to.equal(false);
    expect(await safeB.isOwner(nonOwner.address)).to.equal(true);
  });

  it("rejects a threshold higher than the number of owners — the real Safe contract's own invariant, not something this Feature re-implements", async () => {
    await expect(deployRealSafe([owner1.address, owner2.address], 3)).to.be.reverted;
  });
});
