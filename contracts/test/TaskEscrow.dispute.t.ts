import { expect } from "chai";
import { ethers } from "hardhat";
import type { TaskEscrow, YDToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TaskEscrow.openDispute / resolveDispute (AC-107)", () => {
  let requester: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let otherAgent: HardhatEthersSigner;
  let authorizedSigner: HardhatEthersSigner;
  let arbitrator: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;
  let escrowAddress: string;
  let tokenAddress: string;
  let chainId: bigint;

  const budget = ethers.parseUnits("100", 18);
  const oneDay = 24 * 60 * 60;
  const reviewWindow = 259200; // 72h, matches the constructor arg used below

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

  const mintAndApprove = async (signer: HardhatEthersSigner, amount: bigint): Promise<void> => {
    await token.connect(requester).transfer(signer.address, amount);
    await token.connect(signer).approve(escrowAddress, ethers.MaxUint256);
  };

  // Creates a task and drives it through OPEN -> ACCEPTED so each test can start from a known
  // ACCEPTED state without repeating the full createTask/acceptTask ceremony inline.
  const createAcceptedTask = async (
    id: string,
    taskBudget: bigint,
    nonce: bigint,
    deadlineOffsetSeconds: number = oneDay,
  ): Promise<void> => {
    const deadline = await futureDeadline(deadlineOffsetSeconds);
    await escrow.connect(requester).createTask(id, tokenAddress, taskBudget, deadline);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);
    await escrow.connect(agent).acceptTask(permit, signature);
  };

  // Drives a task from OPEN all the way to SUBMITTED.
  const createSubmittedTask = async (
    id: string,
    taskBudget: bigint,
    nonce: bigint,
  ): Promise<void> => {
    await createAcceptedTask(id, taskBudget, nonce);
    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`result-${id}`));
    await escrow.connect(agent).submitResult(id, resultHash);
  };

  beforeEach(async () => {
    [requester, agent, otherAgent, authorizedSigner, arbitrator] = await ethers.getSigners();

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

    await mintAndApprove(agent, ethers.parseUnits("1000", 18));
    await mintAndApprove(otherAgent, ethers.parseUnits("1000", 18));
  });

  describe("openDispute", () => {
    it("moves SUBMITTED -> DISPUTED within the review window, stores the evidence hash, and emits DisputeOpened", async () => {
      const id = taskId("task-dispute-open-1");
      await createSubmittedTask(id, budget, 0n);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence-1"));

      await expect(escrow.connect(requester).openDispute(id, evidenceHash))
        .to.emit(escrow, "DisputeOpened")
        .withArgs(id, requester.address, evidenceHash);

      const task = await escrow.getTask(id);
      expect(task.status).to.equal(3n); // TaskStatus.DISPUTED
      expect(task.disputeEvidenceHash).to.equal(evidenceHash);
    });

    it("rejects a caller other than the task's requester", async () => {
      const id = taskId("task-dispute-wrong-caller");
      await createSubmittedTask(id, budget, 1n);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence-x"));

      await expect(
        escrow.connect(agent).openDispute(id, evidenceHash),
      ).to.be.revertedWithCustomError(escrow, "NotTaskRequester");

      await expect(
        escrow.connect(otherAgent).openDispute(id, evidenceHash),
      ).to.be.revertedWithCustomError(escrow, "NotTaskRequester");
    });

    it("rejects opening a dispute when the task is not yet SUBMITTED (still ACCEPTED)", async () => {
      const id = taskId("task-dispute-still-accepted");
      await createAcceptedTask(id, budget, 2n);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence-early"));

      await expect(
        escrow.connect(requester).openDispute(id, evidenceHash),
      ).to.be.revertedWithCustomError(escrow, "TaskNotSubmitted");
    });

    it("rejects opening a dispute once the reviewDeadline has passed", async () => {
      const id = taskId("task-dispute-too-late");
      await createSubmittedTask(id, budget, 3n);

      await ethers.provider.send("evm_increaseTime", [reviewWindow + 1]);
      await ethers.provider.send("evm_mine", []);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence-late"));

      await expect(
        escrow.connect(requester).openDispute(id, evidenceHash),
      ).to.be.revertedWithCustomError(escrow, "ReviewDeadlinePassed");
    });

    it("rejects opening a dispute exactly at the reviewDeadline (>= boundary, not just >)", async () => {
      const id = taskId("task-dispute-exact-deadline");
      await createSubmittedTask(id, budget, 4n);

      const task = await escrow.getTask(id);
      const exactReviewDeadline = task.reviewDeadline;

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(exactReviewDeadline)]);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence-exact"));

      await expect(
        escrow.connect(requester).openDispute(id, evidenceHash),
      ).to.be.revertedWithCustomError(escrow, "ReviewDeadlinePassed");
    });

    it("pauses the normal timeout settlement path: finalizeReviewTimeout reverts once a dispute is opened (AC-107)", async () => {
      const id = taskId("task-dispute-pauses-timeout");
      await createSubmittedTask(id, budget, 5n);

      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence-pause"));
      await escrow.connect(requester).openDispute(id, evidenceHash);

      // Advance past reviewDeadline: under the normal (non-disputed) path, finalizeReviewTimeout
      // would now succeed. With the task DISPUTED, it must instead revert with TaskNotSubmitted.
      await ethers.provider.send("evm_increaseTime", [reviewWindow + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        escrow.connect(otherAgent).finalizeReviewTimeout(id),
      ).to.be.revertedWithCustomError(escrow, "TaskNotSubmitted");

      const task = await escrow.getTask(id);
      expect(task.status).to.equal(3n); // still DISPUTED, not silently RELEASED
    });
  });

  describe("resolveDispute", () => {
    const disputeFor = async (id: string, taskBudget: bigint, nonce: bigint): Promise<void> => {
      await createSubmittedTask(id, taskBudget, nonce);
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(`evidence-${id}`));
      await escrow.connect(requester).openDispute(id, evidenceHash);
    };

    it("supporting the agent moves DISPUTED -> RELEASED, pays budget+stake to the agent, and emits DisputeResolved", async () => {
      const id = taskId("task-resolve-support-agent");
      await disputeFor(id, budget, 10n);

      const task = await escrow.getTask(id);
      const expectedStake = task.stake;
      const agentBalanceBefore = await token.balanceOf(agent.address);
      const escrowBalanceBefore = await token.balanceOf(escrowAddress);

      await expect(escrow.connect(arbitrator).resolveDispute(id, true))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(id, true);

      const taskAfter = await escrow.getTask(id);
      expect(taskAfter.status).to.equal(4n); // TaskStatus.RELEASED

      expect(await token.balanceOf(agent.address)).to.equal(
        agentBalanceBefore + budget + expectedStake,
      );
      expect(await token.balanceOf(escrowAddress)).to.equal(
        escrowBalanceBefore - budget - expectedStake,
      );
    });

    it("supporting the requester moves DISPUTED -> REFUNDED, pays budget+stake to the requester, and emits DisputeResolved", async () => {
      const id = taskId("task-resolve-support-requester");
      await disputeFor(id, budget, 11n);

      const task = await escrow.getTask(id);
      const expectedStake = task.stake;
      const requesterBalanceBefore = await token.balanceOf(requester.address);
      const escrowBalanceBefore = await token.balanceOf(escrowAddress);

      await expect(escrow.connect(arbitrator).resolveDispute(id, false))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(id, false);

      const taskAfter = await escrow.getTask(id);
      expect(taskAfter.status).to.equal(5n); // TaskStatus.REFUNDED

      expect(await token.balanceOf(requester.address)).to.equal(
        requesterBalanceBefore + budget + expectedStake,
      );
      expect(await token.balanceOf(escrowAddress)).to.equal(
        escrowBalanceBefore - budget - expectedStake,
      );
    });

    it("rejects a non-arbitrator caller, including the requester and the agent themselves", async () => {
      const id = taskId("task-resolve-wrong-caller");
      await disputeFor(id, budget, 12n);

      await expect(
        escrow.connect(requester).resolveDispute(id, true),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");

      await expect(escrow.connect(agent).resolveDispute(id, true)).to.be.revertedWithCustomError(
        escrow,
        "NotArbitrator",
      );

      await expect(
        escrow.connect(otherAgent).resolveDispute(id, false),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");
    });

    it("rejects resolution when the task is not DISPUTED (still SUBMITTED, dispute never opened)", async () => {
      const id = taskId("task-resolve-still-submitted");
      await createSubmittedTask(id, budget, 13n);

      await expect(
        escrow.connect(arbitrator).resolveDispute(id, true),
      ).to.be.revertedWithCustomError(escrow, "TaskNotDisputed");
    });

    it("rejects a second resolution once the task is already resolved (double-resolution)", async () => {
      const id = taskId("task-resolve-twice");
      await disputeFor(id, budget, 14n);

      await escrow.connect(arbitrator).resolveDispute(id, true);

      await expect(
        escrow.connect(arbitrator).resolveDispute(id, false),
      ).to.be.revertedWithCustomError(escrow, "TaskNotDisputed");
    });
  });

  describe("constructor arbitrator validation", () => {
    it("reverts deployment with a zero-address arbitrator", async () => {
      const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
      await expect(
        escrowFactory.deploy(
          tokenAddress,
          authorizedSigner.address,
          reviewWindow,
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(escrow, "ZeroArbitrator");
    });
  });

  describe("ARBITRATOR_ROLE rotation", () => {
    it("lets the deployer (DEFAULT_ADMIN_ROLE) revoke the initial arbitrator and grant a new one", async () => {
      const arbitratorRole = await escrow.ARBITRATOR_ROLE();
      expect(await escrow.hasRole(arbitratorRole, arbitrator.address)).to.equal(true);
      expect(await escrow.hasRole(arbitratorRole, otherAgent.address)).to.equal(false);

      // Simulates rotating away from a lost/compromised arbitrator key without redeploying.
      await escrow.connect(requester).revokeRole(arbitratorRole, arbitrator.address);
      await escrow.connect(requester).grantRole(arbitratorRole, otherAgent.address);

      expect(await escrow.hasRole(arbitratorRole, arbitrator.address)).to.equal(false);
      expect(await escrow.hasRole(arbitratorRole, otherAgent.address)).to.equal(true);

      const id = taskId("task-resolve-after-rotation");
      await createSubmittedTask(id, budget, 20n);
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(`evidence-${id}`));
      await escrow.connect(requester).openDispute(id, evidenceHash);

      // The old arbitrator can no longer resolve disputes...
      await expect(
        escrow.connect(arbitrator).resolveDispute(id, true),
      ).to.be.revertedWithCustomError(escrow, "NotArbitrator");

      // ...but the newly-granted address can, against the same still-live escrow instance (no
      // redeploy, no loss of access to funds already locked for this or any other disputed task).
      await expect(escrow.connect(otherAgent).resolveDispute(id, true))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(id, true);
    });

    it("rejects a non-admin attempting to grant or revoke ARBITRATOR_ROLE", async () => {
      const arbitratorRole = await escrow.ARBITRATOR_ROLE();

      await expect(escrow.connect(agent).grantRole(arbitratorRole, agent.address)).to.be.reverted;
      await expect(escrow.connect(agent).revokeRole(arbitratorRole, arbitrator.address)).to.be
        .reverted;
    });
  });
});
