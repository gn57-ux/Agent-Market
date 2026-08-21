import { expect } from "chai";
import { ethers } from "hardhat";
import type { TaskEscrow, YDToken, FeeOnTransferMockToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TaskEscrow.createTask (AC-101)", () => {
  let requester: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;

  const budget = ethers.parseUnits("100", 18);
  const oneDay = 24 * 60 * 60;

  const taskId = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label));

  const futureDeadline = async (offsetSeconds: number): Promise<bigint> => {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) {
      throw new Error("no latest block");
    }
    return BigInt(latest.timestamp + offsetSeconds);
  };

  beforeEach(async () => {
    [requester, other] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", requester);
    token = await tokenFactory.deploy(requester.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
    escrow = await escrowFactory.deploy();
    await escrow.waitForDeployment();

    await token.connect(requester).approve(await escrow.getAddress(), ethers.MaxUint256);
  });

  it("transfers 100% of budget into escrow and stores the task", async () => {
    const id = taskId("task-1");
    const deadline = await futureDeadline(oneDay);
    const escrowAddress = await escrow.getAddress();

    await expect(
      escrow.connect(requester).createTask(id, await token.getAddress(), budget, deadline),
    )
      .to.emit(escrow, "TaskFunded")
      .withArgs(id, requester.address, await token.getAddress(), budget, deadline);

    expect(await token.balanceOf(escrowAddress)).to.equal(budget);

    const task = await escrow.getTask(id);
    expect(task.taskId).to.equal(id);
    expect(task.requester).to.equal(requester.address);
    expect(task.agent).to.equal(ethers.ZeroAddress);
    expect(task.token).to.equal(await token.getAddress());
    expect(task.budget).to.equal(budget);
    expect(task.stake).to.equal(0n);
    expect(task.deliveryDeadline).to.equal(deadline);
    expect(task.submittedAt).to.equal(0n);
    expect(task.reviewDeadline).to.equal(0n);
    expect(task.resultHash).to.equal(ethers.ZeroHash);
    expect(task.disputeEvidenceHash).to.equal(ethers.ZeroHash);
    expect(task.status).to.equal(0n); // TaskStatus.OPEN
  });

  it("rejects zero budget", async () => {
    const id = taskId("task-zero-budget");
    const deadline = await futureDeadline(oneDay);

    await expect(
      escrow.connect(requester).createTask(id, await token.getAddress(), 0n, deadline),
    ).to.be.revertedWithCustomError(escrow, "ZeroBudget");
  });

  it("rejects a fee-on-transfer / deflationary token", async () => {
    const mockFactory = await ethers.getContractFactory("FeeOnTransferMockToken", requester);
    const feeToken = (await mockFactory.deploy(500n)) as FeeOnTransferMockToken; // 5% fee
    await feeToken.waitForDeployment();
    await feeToken.mint(requester.address, budget);
    await feeToken.connect(requester).approve(await escrow.getAddress(), ethers.MaxUint256);

    const id = taskId("task-fee-on-transfer");
    const deadline = await futureDeadline(oneDay);

    await expect(
      escrow.connect(requester).createTask(id, await feeToken.getAddress(), budget, deadline),
    ).to.be.revertedWithCustomError(escrow, "FeeOnTransferTokenNotSupported");
  });

  it("rejects a deliveryDeadline that is not in the future", async () => {
    const id = taskId("task-past-deadline");
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) {
      throw new Error("no latest block");
    }
    const notInFuture = BigInt(latest.timestamp);

    await expect(
      escrow.connect(requester).createTask(id, await token.getAddress(), budget, notInFuture),
    ).to.be.revertedWithCustomError(escrow, "InvalidDeliveryDeadline");
  });

  it("rejects a duplicate taskId", async () => {
    const id = taskId("task-duplicate");
    const deadline = await futureDeadline(oneDay);

    await escrow.connect(requester).createTask(id, await token.getAddress(), budget, deadline);

    const secondDeadline = await futureDeadline(oneDay * 2);
    await expect(
      escrow.connect(requester).createTask(id, await token.getAddress(), budget, secondDeadline),
    ).to.be.revertedWithCustomError(escrow, "TaskAlreadyExists");
  });

  it("reverts getTask for an unknown taskId instead of returning a zeroed struct", async () => {
    const id = taskId("task-never-created");

    await expect(escrow.getTask(id)).to.be.revertedWithCustomError(escrow, "TaskNotFound");
  });

  it("reverts createTask when the requester has not approved enough allowance", async () => {
    const id = taskId("task-no-allowance");
    const deadline = await futureDeadline(oneDay);

    await token.connect(requester).approve(await escrow.getAddress(), 0n);

    await expect(
      escrow.connect(requester).createTask(id, await token.getAddress(), budget, deadline),
    ).to.be.reverted;

    // sanity: other signer never touched approvals at all
    await expect(escrow.connect(other).createTask(id, await token.getAddress(), budget, deadline))
      .to.be.reverted;
  });
});
