import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { TaskEscrow, YDToken } from "../typechain-types";
import { deployRealSafe } from "./helpers/safe";

/**
 * Feature 21 (arbitration-committee), T-2104 (F-2113 升级方案，步骤 2；
 * requirements.md AC-2102/AC-2103 前半/AC-2104).
 *
 * The real rotation logic this Task's own `scripts/rotate-arbitrator-
 * role.ts` performs against a real deployed `TaskEscrow`, exercised here
 * directly against this project's real local Hardhat network (the exact
 * same environment every `contracts/test/*.t.ts` file already runs
 * against — not a separate mock). Proves: the old single-EOA arbitrator
 * genuinely loses the ability to call `resolveDispute` the instant the
 * role is revoked, the real deployed Safe address genuinely gains
 * `ARBITRATOR_ROLE`, only `DEFAULT_ADMIN_ROLE` can perform the rotation
 * calls themselves, and `TaskEscrow`'s own fund conservation on a REAL
 * disputed task (real budget+stake, real token balance movements) is
 * completely unaffected by which address holds the role at the moment
 * `resolveDispute` is actually called (F-2113: "不改变任何资金规则，
 * 只改变角色持有者").
 */
describe("TaskEscrow ARBITRATOR_ROLE rotation onto a real Safe (T-2104)", () => {
  let admin: HardhatEthersSigner;
  let requester: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let oldArbitrator: HardhatEthersSigner;
  let safeOwner1: HardhatEthersSigner;
  let safeOwner2: HardhatEthersSigner;
  let safeOwner3: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;
  let tokenAddress: string;
  let escrowAddress: string;
  let chainId: bigint;

  const budget = ethers.parseUnits("100", 18);
  const reviewWindow = 259200;
  const oneDay = 24 * 60 * 60;

  const domain = (verifyingContract: string) => ({
    name: "AgentMarketTaskEscrow",
    version: "1",
    chainId,
    verifyingContract,
  });

  const types = {
    AcceptancePermit: [
      { name: "taskId", type: "bytes32" },
      { name: "agent", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  };

  interface AcceptancePermit {
    taskId: string;
    agent: string;
    nonce: bigint;
    expiry: bigint;
    chainId: bigint;
    verifyingContract: string;
  }

  const futureDeadline = async (offsetSeconds: number): Promise<bigint> => {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("no latest block");
    return BigInt(latest.timestamp + offsetSeconds);
  };

  beforeEach(async () => {
    [admin, requester, agent, oldArbitrator, safeOwner1, safeOwner2, safeOwner3] =
      await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", admin);
    token = await tokenFactory.deploy(admin.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", admin);
    // `admin` is BOTH the deployer (holds DEFAULT_ADMIN_ROLE, needed to
    // perform the rotation itself) and the authorized permit signer here
    // — this Task's own scope is the ROLE rotation, not permit-signing
    // key management, so reusing one signer for both real roles keeps
    // the setup minimal without weakening what this file actually tests.
    escrow = await escrowFactory.deploy(
      tokenAddress,
      admin.address,
      reviewWindow,
      oldArbitrator.address,
    );
    await escrow.waitForDeployment();
    escrowAddress = await escrow.getAddress();

    const network = await ethers.provider.getNetwork();
    chainId = network.chainId;

    await token.transfer(requester.address, budget);
    await token.connect(requester).approve(escrowAddress, budget);
    await token.transfer(agent.address, ethers.parseUnits("1000", 18));
    await token.connect(agent).approve(escrowAddress, ethers.MaxUint256);
  });

  async function rotateToSafe(): Promise<string> {
    const safe = await deployRealSafe(
      [safeOwner1.address, safeOwner2.address, safeOwner3.address],
      2,
    );
    const safeAddress = await safe.getAddress();
    const arbitratorRole = await escrow.ARBITRATOR_ROLE();
    await (await escrow.connect(admin).grantRole(arbitratorRole, safeAddress)).wait();
    await (await escrow.connect(admin).revokeRole(arbitratorRole, oldArbitrator.address)).wait();
    return safeAddress;
  }

  async function disputeSubmittedTask(): Promise<string> {
    const id = ethers.keccak256(ethers.toUtf8Bytes(`rotation-task-${Date.now()}-${Math.random()}`));
    const deadline = await futureDeadline(oneDay * 7);
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await admin.signTypedData(domain(escrowAddress), types, permit);
    await escrow.connect(agent).acceptTask(permit, signature);

    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`result-${id}`));
    await escrow.connect(agent).submitResult(id, resultHash);

    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(`evidence-${id}`));
    await escrow.connect(requester).openDispute(id, evidenceHash);
    return id;
  }

  it("grants ARBITRATOR_ROLE to a real deployed Safe and revokes it from the old EOA — the old holder can no longer resolveDispute, the Safe address now hasRole", async () => {
    const arbitratorRole = await escrow.ARBITRATOR_ROLE();
    const disputeId = await disputeSubmittedTask();

    expect(await escrow.hasRole(arbitratorRole, oldArbitrator.address)).to.equal(true);

    const safeAddress = await rotateToSafe();

    expect(await escrow.hasRole(arbitratorRole, safeAddress)).to.equal(true);
    expect(await escrow.hasRole(arbitratorRole, oldArbitrator.address)).to.equal(false);

    // AC-2102: the old holder must genuinely lose the ability to act on
    // a REAL still-open dispute — not just fail an off-chain `hasRole`
    // read while some other code path would still let the call through.
    await expect(
      escrow.connect(oldArbitrator).resolveDispute(disputeId, true),
    ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
  });

  it("rejects the rotation calls themselves from a non-admin account — only DEFAULT_ADMIN_ROLE can perform F-2113's step 2", async () => {
    const safe = await deployRealSafe(
      [safeOwner1.address, safeOwner2.address, safeOwner3.address],
      2,
    );
    const safeAddress = await safe.getAddress();
    const arbitratorRole = await escrow.ARBITRATOR_ROLE();

    await expect(escrow.connect(requester).grantRole(arbitratorRole, safeAddress)).to.be.reverted;
    await expect(escrow.connect(agent).revokeRole(arbitratorRole, oldArbitrator.address)).to.be
      .reverted;

    // Real on-chain state is unchanged by the rejected attempts above.
    expect(await escrow.hasRole(arbitratorRole, oldArbitrator.address)).to.equal(true);
    expect(await escrow.hasRole(arbitratorRole, safeAddress)).to.equal(false);
  });

  // N4 real finding (P2, round 1, T-2104): the previous version of this
  // file only asserted `hasRole`/revert behavior — it never touched a
  // real budget+stake or compared real token balances, so it could not
  // actually support F-2113's own literal claim ("不改变任何资金规则，
  // 只改变角色持有者"). This test opens a REAL dispute on a REAL
  // budget-funded task, rotates the role mid-flight, and proves the
  // Safe address's own `resolveDispute` call pays out EXACTLY what the
  // pre-rotation `arbitrator` EOA would have paid — the same real
  // balance-delta assertions `TaskEscrow.dispute.t.ts`'s own
  // `resolveDispute` tests already make for the single-EOA path.
  it("fund conservation is unaffected by rotation — a real dispute resolved by the Safe pays out identically to the pre-rotation single-EOA path", async () => {
    const disputeId = await disputeSubmittedTask();
    const safeAddress = await rotateToSafe();

    const task = await escrow.getTask(disputeId);
    const expectedStake = task.stake;
    const agentBalanceBefore = await token.balanceOf(agent.address);
    const escrowBalanceBefore = await token.balanceOf(escrowAddress);

    // T-2105's own scope is the FULL real 2-of-3 Safe-signed execution
    // path (`execTransaction`) — this Task only needs to prove the FUND
    // RULES `resolveDispute` executes are unaffected by rotation, so the
    // real deployed Safe address (the exact on-chain account
    // `ARBITRATOR_ROLE` was granted to above) calls `resolveDispute`
    // directly via Hardhat's `impersonateAccount` rather than going
    // through a real 2-of-3 signature collection — proving identical
    // outcomes for identical inputs regardless of caller identity
    // (F-2113's own literal claim); proving that identity is REACHABLE
    // only via 2 real Safe signatures is T-2105's own, separate, larger
    // scope.
    await ethers.provider.send("hardhat_impersonateAccount", [safeAddress]);
    await ethers.provider.send("hardhat_setBalance", [
      safeAddress,
      ethers.toQuantity(ethers.parseEther("10")),
    ]);
    const safeSigner = await ethers.getSigner(safeAddress);

    await expect(escrow.connect(safeSigner).resolveDispute(disputeId, true))
      .to.emit(escrow, "DisputeResolved")
      .withArgs(disputeId, true);

    const taskAfter = await escrow.getTask(disputeId);
    expect(taskAfter.status).to.equal(4n); // TaskStatus.RELEASED
    expect(await token.balanceOf(agent.address)).to.equal(
      agentBalanceBefore + budget + expectedStake,
    );
    expect(await token.balanceOf(escrowAddress)).to.equal(
      escrowBalanceBefore - budget - expectedStake,
    );

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [safeAddress]);
  });
});
