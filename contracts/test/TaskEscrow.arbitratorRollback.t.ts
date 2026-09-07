import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { TaskEscrow, YDToken } from "../typechain-types";
import { deployRealSafe } from "./helpers/safe";
import { rotateArbitratorRole } from "../scripts/rotate-arbitrator-role";

/**
 * Feature 21 (arbitration-committee), T-2109 (design.md"F-2113 升级方案"
 * 步骤 5：回滚路径). Requirements.md 风险章节: "T-2104/T-2105 涉及真实资金
 * 裁决权变更，任何一步都必须先有测试覆盖" — 本 Task 是这条要求的镜像
 * 半：证明反向轮换（Safe → 单一 EOA）与正向轮换一样真实、一样安全。
 *
 * A full real round trip on the SAME real local Hardhat network: single
 * EOA → real deployed Safe (T-2103/T-2104's own real forward rotation,
 * reusing `rotateArbitratorRole` with `ROTATION_MODE=forward`) → back to
 * the ORIGINAL single EOA (`ROTATION_MODE=rollback`). After the real
 * rollback, `TaskEscrow.dispute.t.ts`'s own regression baseline (T-2101)
 * must still fully pass — this Task's own literal verification
 * requirement — and this file additionally proves the restored EOA can
 * genuinely resolve a real dispute again, exactly like before any
 * rotation ever happened.
 */
describe("TaskEscrow ARBITRATOR_ROLE rollback: Safe -> original single EOA (T-2109)", () => {
  let admin: HardhatEthersSigner;
  let requester: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let originalArbitrator: HardhatEthersSigner;
  let safeOwner1: HardhatEthersSigner;
  let safeOwner2: HardhatEthersSigner;
  let safeOwner3: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;
  let tokenAddress: string;
  let escrowAddress: string;
  let chainId: bigint;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "TASK_ESCROW_ADDRESS",
    "NEW_ARBITRATOR_ADDRESS",
    "OLD_ARBITRATOR_ADDRESS",
    "ROTATION_MODE",
  ];

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

  const futureDeadline = async (offsetSeconds: number): Promise<bigint> => {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("no latest block");
    return BigInt(latest.timestamp + offsetSeconds);
  };

  before(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  after(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(async () => {
    [admin, requester, agent, originalArbitrator, safeOwner1, safeOwner2, safeOwner3] =
      await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", admin);
    token = await tokenFactory.deploy(admin.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", admin);
    escrow = await escrowFactory.deploy(
      tokenAddress,
      admin.address,
      reviewWindow,
      originalArbitrator.address,
    );
    await escrow.waitForDeployment();
    escrowAddress = await escrow.getAddress();

    const network = await ethers.provider.getNetwork();
    chainId = network.chainId;

    await token.transfer(requester.address, budget * 2n);
    await token.connect(requester).approve(escrowAddress, ethers.MaxUint256);
    await token.transfer(agent.address, ethers.parseUnits("1000", 18));
    await token.connect(agent).approve(escrowAddress, ethers.MaxUint256);

    for (const key of ENV_KEYS) delete process.env[key];
  });

  async function disputeSubmittedTask(): Promise<string> {
    const id = ethers.keccak256(
      ethers.toUtf8Bytes(`rollback-drill-task-${Date.now()}-${Math.random()}`),
    );
    const deadline = await futureDeadline(oneDay * 7);
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    const permit = {
      taskId: id,
      agent: agent.address,
      nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
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

  it("real round trip: EOA -> Safe -> back to the SAME original EOA, and the restored EOA can genuinely resolve a real dispute again", async () => {
    const arbitratorRole = await escrow.ARBITRATOR_ROLE();
    const safe = await deployRealSafe(
      [safeOwner1.address, safeOwner2.address, safeOwner3.address],
      2,
    );
    const safeAddress = await safe.getAddress();

    // Real forward rotation (T-2104's own script, real network calls).
    process.env.TASK_ESCROW_ADDRESS = escrowAddress;
    process.env.NEW_ARBITRATOR_ADDRESS = safeAddress;
    process.env.OLD_ARBITRATOR_ADDRESS = originalArbitrator.address;
    process.env.ROTATION_MODE = "forward";
    await rotateArbitratorRole();

    expect(await escrow.hasRole(arbitratorRole, safeAddress)).to.equal(true);
    expect(await escrow.hasRole(arbitratorRole, originalArbitrator.address)).to.equal(false);

    // Real rollback: Safe -> the SAME original EOA address (design.md's
    // own step 5 — parameters swapped, same script, `ROTATION_MODE`
    // flipped to `rollback` so the real bytecode-type guard (T-2104's
    // own N4 round-2 fix) validates the target is genuinely an EOA this
    // time, not a contract).
    process.env.NEW_ARBITRATOR_ADDRESS = originalArbitrator.address;
    process.env.OLD_ARBITRATOR_ADDRESS = safeAddress;
    process.env.ROTATION_MODE = "rollback";
    await rotateArbitratorRole();

    expect(await escrow.hasRole(arbitratorRole, originalArbitrator.address)).to.equal(true);
    expect(await escrow.hasRole(arbitratorRole, safeAddress)).to.equal(false);

    // The restored EOA can genuinely act again — real dispute, real
    // resolution, real fund movement, exactly like before any rotation.
    const disputeId = await disputeSubmittedTask();
    const task = await escrow.getTask(disputeId);
    const expectedStake = task.stake;
    const agentBalanceBefore = await token.balanceOf(agent.address);
    const escrowBalanceBefore = await token.balanceOf(escrowAddress);

    await expect(escrow.connect(originalArbitrator).resolveDispute(disputeId, true))
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

    // The Safe, having been rolled back, can no longer act either.
    await ethers.provider.send("hardhat_impersonateAccount", [safeAddress]);
    await ethers.provider.send("hardhat_setBalance", [
      safeAddress,
      ethers.toQuantity(ethers.parseEther("10")),
    ]);
    const safeSigner = await ethers.getSigner(safeAddress);
    const anotherDisputeId = await disputeSubmittedTask();
    await expect(
      escrow.connect(safeSigner).resolveDispute(anotherDisputeId, true),
    ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [safeAddress]);
  });
});
