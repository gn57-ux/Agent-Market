import { expect } from "chai";
import { ethers } from "hardhat";
import type { TaskEscrow, YDToken, MaliciousReentrantToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TaskEscrow.cancelTask (F-111, AC-108, AC-109, AC-111)", () => {
  let requester: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let authorizedSigner: HardhatEthersSigner;
  let arbitrator: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;
  let escrowAddress: string;
  let tokenAddress: string;
  let chainId: bigint;

  const budget = ethers.parseUnits("100", 18);
  const oneDay = 24 * 60 * 60;
  const reviewWindow = 259200; // 72h

  const taskId = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label));

  const futureDeadline = async (offsetSeconds: number): Promise<bigint> => {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) {
      throw new Error("no latest block");
    }
    return BigInt(latest.timestamp + offsetSeconds);
  };

  const domain = (verifyingContract: string = escrowAddress) => ({
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

  const signPermit = async (
    signer: HardhatEthersSigner,
    permit: AcceptancePermit,
    verifyingContract: string = escrowAddress,
  ): Promise<string> => signer.signTypedData(domain(verifyingContract), types, permit);

  beforeEach(async () => {
    [requester, agent, other, authorizedSigner, arbitrator] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", requester);
    token = await tokenFactory.deploy(requester.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
    escrow = await escrowFactory.deploy(
      tokenAddress,
      authorizedSigner.address,
      reviewWindow,
      arbitrator.address,
    );
    await escrow.waitForDeployment();
    escrowAddress = await escrow.getAddress();

    await token.connect(requester).approve(escrowAddress, ethers.MaxUint256);

    const network = await ethers.provider.getNetwork();
    chainId = network.chainId;
  });

  it("moves OPEN -> CANCELLED, refunds 100% of budget to the requester, and emits TaskCancelled", async () => {
    const id = taskId("task-cancel-1");
    const deadline = await futureDeadline(oneDay);
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    const requesterBalanceBefore = await token.balanceOf(requester.address);
    const escrowBalanceBefore = await token.balanceOf(escrowAddress);

    await expect(escrow.connect(requester).cancelTask(id))
      .to.emit(escrow, "TaskCancelled")
      .withArgs(id);

    const task = await escrow.getTask(id);
    expect(task.status).to.equal(6n); // TaskStatus.CANCELLED

    expect(await token.balanceOf(requester.address)).to.equal(requesterBalanceBefore + budget);
    expect(await token.balanceOf(escrowAddress)).to.equal(escrowBalanceBefore - budget);
  });

  it("rejects a caller other than the task's requester", async () => {
    const id = taskId("task-cancel-wrong-caller");
    const deadline = await futureDeadline(oneDay);
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    await expect(escrow.connect(other).cancelTask(id)).to.be.revertedWithCustomError(
      escrow,
      "NotTaskRequester",
    );

    const task = await escrow.getTask(id);
    expect(task.status).to.equal(0n); // still OPEN
  });

  it("rejects cancelling an ACCEPTED task (AC-111)", async () => {
    const id = taskId("task-cancel-already-accepted");
    const deadline = await futureDeadline(oneDay);
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    await token.connect(requester).transfer(agent.address, ethers.parseUnits("1000", 18));
    await token.connect(agent).approve(escrowAddress, ethers.MaxUint256);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);
    await escrow.connect(agent).acceptTask(permit, signature);

    await expect(escrow.connect(requester).cancelTask(id)).to.be.revertedWithCustomError(
      escrow,
      "TaskNotOpen",
    );

    const task = await escrow.getTask(id);
    expect(task.status).to.equal(1n); // still ACCEPTED, not silently CANCELLED
  });

  it("rejects a second cancel once the task is already CANCELLED (double-cancel, AC-108)", async () => {
    const id = taskId("task-cancel-twice");
    const deadline = await futureDeadline(oneDay);
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    await escrow.connect(requester).cancelTask(id);

    await expect(escrow.connect(requester).cancelTask(id)).to.be.revertedWithCustomError(
      escrow,
      "TaskNotOpen",
    );
  });

  it("rejects an unknown taskId", async () => {
    const id = taskId("task-cancel-unknown");

    await expect(escrow.connect(requester).cancelTask(id)).to.be.revertedWithCustomError(
      escrow,
      "TaskNotFound",
    );
  });

  it("blocks a reentrant call attempted from within the refund transfer (AC-109)", async () => {
    // A malicious token whose `transfer` tries to call back into `cancelTask` for the same
    // task before the outer transfer completes. `nonReentrant` must reject that inner call
    // while still letting the outer, legitimate transfer go through.
    const evilFactory = await ethers.getContractFactory("MaliciousReentrantToken", requester);
    const evilToken = (await evilFactory.deploy()) as MaliciousReentrantToken;
    await evilToken.waitForDeployment();
    const evilTokenAddress = await evilToken.getAddress();

    const evilEscrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
    const evilEscrow = await evilEscrowFactory.deploy(
      evilTokenAddress,
      authorizedSigner.address,
      reviewWindow,
      arbitrator.address,
    );
    await evilEscrow.waitForDeployment();
    const evilEscrowAddress = await evilEscrow.getAddress();

    await evilToken.mint(requester.address, budget);
    await evilToken.connect(requester).approve(evilEscrowAddress, ethers.MaxUint256);

    const id = taskId("task-cancel-reentrancy");
    const deadline = await futureDeadline(oneDay);
    await evilEscrow.connect(requester).createTask(id, evilTokenAddress, budget, deadline);

    const reentrantCalldata = evilEscrow.interface.encodeFunctionData("cancelTask", [id]);
    await evilToken.armReentrancy(evilEscrowAddress, reentrantCalldata);

    const requesterBalanceBefore = await evilToken.balanceOf(requester.address);

    // The outer cancelTask call itself must succeed: the reentrant attempt inside `transfer`
    // fails silently (its result is ignored by the mock), the legitimate transfer still runs.
    await expect(evilEscrow.connect(requester).cancelTask(id)).to.not.be.reverted;

    expect(await evilToken.attackSucceeded()).to.equal(false);
    expect(await evilToken.balanceOf(requester.address)).to.equal(requesterBalanceBefore + budget);

    const task = await evilEscrow.getTask(id);
    expect(task.status).to.equal(6n); // CANCELLED exactly once, not double-processed
  });
});
