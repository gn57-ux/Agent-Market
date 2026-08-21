import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { YDToken, YDFaucet } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("YDFaucet", () => {
  let deployer: HardhatEthersSigner;
  let claimer: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let token: YDToken;
  let faucet: YDFaucet;

  const claimAmount = ethers.parseUnits("10", 18);
  const cooldownPeriod = 3600; // 1 hour

  beforeEach(async () => {
    [deployer, claimer, other] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", deployer);
    token = await tokenFactory.deploy(deployer.address, 0n);
    await token.waitForDeployment();

    const faucetFactory = await ethers.getContractFactory("YDFaucet", deployer);
    faucet = await faucetFactory.deploy(await token.getAddress(), claimAmount, cooldownPeriod);
    await faucet.waitForDeployment();

    // Faucet must own the token to be able to mint on claim.
    await token.connect(deployer).transferOwnership(await faucet.getAddress());
  });

  it("mints claimAmount to the caller on a successful claim", async () => {
    const tx = await faucet.connect(claimer).claim();
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt?.blockNumber ?? 0);

    await expect(tx)
      .to.emit(faucet, "Claimed")
      .withArgs(claimer.address, claimAmount, block?.timestamp);

    expect(await token.balanceOf(claimer.address)).to.equal(claimAmount);
  });

  it("allows different addresses to claim independently", async () => {
    await faucet.connect(claimer).claim();
    await faucet.connect(other).claim();

    expect(await token.balanceOf(claimer.address)).to.equal(claimAmount);
    expect(await token.balanceOf(other.address)).to.equal(claimAmount);
  });

  it("reverts on a second claim before the cooldown elapses", async () => {
    await faucet.connect(claimer).claim();

    await expect(faucet.connect(claimer).claim()).to.be.revertedWithCustomError(
      faucet,
      "CooldownNotElapsed",
    );
  });

  it("allows claiming again once the cooldown period has elapsed", async () => {
    await faucet.connect(claimer).claim();

    await time.increase(cooldownPeriod);

    await expect(faucet.connect(claimer).claim()).to.not.be.reverted;
    expect(await token.balanceOf(claimer.address)).to.equal(claimAmount * 2n);
  });

  it("allows the owner to update the claim amount", async () => {
    const newAmount = ethers.parseUnits("25", 18);
    await expect(faucet.connect(deployer).setClaimAmount(newAmount))
      .to.emit(faucet, "ClaimAmountUpdated")
      .withArgs(newAmount);

    await faucet.connect(claimer).claim();
    expect(await token.balanceOf(claimer.address)).to.equal(newAmount);
  });

  it("allows the owner to update the cooldown period", async () => {
    const newCooldown = 60;
    await expect(faucet.connect(deployer).setCooldownPeriod(newCooldown))
      .to.emit(faucet, "CooldownPeriodUpdated")
      .withArgs(newCooldown);

    await faucet.connect(claimer).claim();
    await time.increase(newCooldown);
    await expect(faucet.connect(claimer).claim()).to.not.be.reverted;
  });

  it("reverts when a non-owner attempts to update configuration", async () => {
    await expect(faucet.connect(other).setClaimAmount(1n)).to.be.revertedWithCustomError(
      faucet,
      "OwnableUnauthorizedAccount",
    );
    await expect(faucet.connect(other).setCooldownPeriod(1n)).to.be.revertedWithCustomError(
      faucet,
      "OwnableUnauthorizedAccount",
    );
  });
});
