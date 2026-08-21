import { expect } from "chai";
import { ethers } from "hardhat";
import type { YDToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("YDToken", () => {
  let deployer: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let token: YDToken;

  const initialSupply = ethers.parseUnits("1000", 18);

  beforeEach(async () => {
    [deployer, other] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("YDToken", deployer);
    token = await factory.deploy(deployer.address, initialSupply);
    await token.waitForDeployment();
  });

  it("sets name, symbol, and decimals", async () => {
    expect(await token.name()).to.equal("Yidian Token");
    expect(await token.symbol()).to.equal("YD");
    expect(await token.decimals()).to.equal(18);
  });

  it("mints the initial supply to the receiver at deployment", async () => {
    expect(await token.balanceOf(deployer.address)).to.equal(initialSupply);
    expect(await token.totalSupply()).to.equal(initialSupply);
  });

  it("allows the owner to mint additional tokens", async () => {
    const mintAmount = ethers.parseUnits("50", 18);
    await expect(token.connect(deployer).mint(other.address, mintAmount))
      .to.emit(token, "Transfer")
      .withArgs(ethers.ZeroAddress, other.address, mintAmount);

    expect(await token.balanceOf(other.address)).to.equal(mintAmount);
    expect(await token.totalSupply()).to.equal(initialSupply + mintAmount);
  });

  it("reverts when a non-owner attempts to mint", async () => {
    const mintAmount = ethers.parseUnits("50", 18);
    await expect(
      token.connect(other).mint(other.address, mintAmount),
    ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });
});
