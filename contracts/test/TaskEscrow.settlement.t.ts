import { expect } from "chai";
import { ethers } from "hardhat";
import type { TaskEscrow, YDToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TaskEscrow.submitResult / approveResult (AC-105, AC-106, AC-112)", () => {
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

  describe("submitResult", () => {
    it("moves ACCEPTED -> SUBMITTED, computes reviewDeadline, and emits ResultSubmitted with exact fields (AC-105, AC-112)", async () => {
      const id = taskId("task-submit-1");
      await createAcceptedTask(id, budget, 0n);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-1"));

      const tx = await escrow.connect(agent).submitResult(id, resultHash);
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error("no receipt");
      }
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      if (!block) {
        throw new Error("no block");
      }
      const expectedSubmittedAt = BigInt(block.timestamp);
      const expectedReviewDeadline = expectedSubmittedAt + BigInt(reviewWindow);

      await expect(tx)
        .to.emit(escrow, "ResultSubmitted")
        .withArgs(id, agent.address, resultHash, expectedSubmittedAt, expectedReviewDeadline);

      const task = await escrow.getTask(id);
      expect(task.status).to.equal(2n); // TaskStatus.SUBMITTED
      expect(task.resultHash).to.equal(resultHash);
      expect(task.submittedAt).to.equal(expectedSubmittedAt);
      expect(task.reviewDeadline).to.equal(expectedReviewDeadline);
      expect(task.reviewDeadline - task.submittedAt).to.equal(BigInt(reviewWindow));
    });

    it("rejects submission by a caller other than the accepted agent", async () => {
      const id = taskId("task-submit-wrong-caller");
      await createAcceptedTask(id, budget, 1n);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-x"));

      await expect(
        escrow.connect(otherAgent).submitResult(id, resultHash),
      ).to.be.revertedWithCustomError(escrow, "NotTaskAgent");
    });

    it("rejects submission when the task is still OPEN (not yet accepted)", async () => {
      const id = taskId("task-submit-still-open");
      const deadline = await futureDeadline(oneDay);
      await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-open"));

      await expect(
        escrow.connect(agent).submitResult(id, resultHash),
      ).to.be.revertedWithCustomError(escrow, "NotTaskAgent");
    });

    it("rejects a second submission once the task is already SUBMITTED", async () => {
      const id = taskId("task-submit-twice");
      await createAcceptedTask(id, budget, 2n);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-once"));
      await escrow.connect(agent).submitResult(id, resultHash);

      await expect(
        escrow.connect(agent).submitResult(id, resultHash),
      ).to.be.revertedWithCustomError(escrow, "TaskNotAccepted");
    });

    it("accepts submission right up to (but not at) the deliveryDeadline (AC-105)", async () => {
      const id = taskId("task-submit-before-deadline");
      await createAcceptedTask(id, budget, 3n, 120); // 2 minutes out

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-in-time"));

      // Still comfortably before deliveryDeadline.
      await expect(escrow.connect(agent).submitResult(id, resultHash)).to.not.be.reverted;

      const task = await escrow.getTask(id);
      expect(task.status).to.equal(2n); // SUBMITTED
    });

    it("rejects submission at or after the deliveryDeadline (AC-105)", async () => {
      const id = taskId("task-submit-after-deadline");
      await createAcceptedTask(id, budget, 4n, 120); // 2 minutes out

      await ethers.provider.send("evm_increaseTime", [180]); // past the 2-minute deadline
      await ethers.provider.send("evm_mine", []);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-late"));

      await expect(
        escrow.connect(agent).submitResult(id, resultHash),
      ).to.be.revertedWithCustomError(escrow, "DeliveryDeadlineAlreadyPassed");

      const task = await escrow.getTask(id);
      expect(task.status).to.equal(1n); // still ACCEPTED, not silently SUBMITTED
    });

    it("rejects submission exactly at the deliveryDeadline (>= boundary, not just >)", async () => {
      const id = taskId("task-submit-exact-deadline");
      await createAcceptedTask(id, budget, 5n, 120);

      const task = await escrow.getTask(id);
      const exactDeadline = task.deliveryDeadline;

      // Mine the submitResult block with timestamp == deliveryDeadline exactly.
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(exactDeadline)]);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-exact-boundary"));

      await expect(
        escrow.connect(agent).submitResult(id, resultHash),
      ).to.be.revertedWithCustomError(escrow, "DeliveryDeadlineAlreadyPassed");
    });
  });

  describe("approveResult", () => {
    const submitFor = async (id: string, taskBudget: bigint, nonce: bigint): Promise<void> => {
      await createAcceptedTask(id, taskBudget, nonce);
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`result-${id}`));
      await escrow.connect(agent).submitResult(id, resultHash);
    };

    it("moves SUBMITTED -> RELEASED, pays budget+stake to the agent, and emits ResultApproved (AC-106)", async () => {
      const id = taskId("task-approve-1");
      await submitFor(id, budget, 3n);

      const task = await escrow.getTask(id);
      const expectedStake = task.stake;
      const agentBalanceBefore = await token.balanceOf(agent.address);
      const escrowBalanceBefore = await token.balanceOf(escrowAddress);

      await expect(escrow.connect(requester).approveResult(id))
        .to.emit(escrow, "ResultApproved")
        .withArgs(id, agent.address, budget, expectedStake);

      const taskAfter = await escrow.getTask(id);
      expect(taskAfter.status).to.equal(4n); // TaskStatus.RELEASED

      expect(await token.balanceOf(agent.address)).to.equal(
        agentBalanceBefore + budget + expectedStake,
      );
      expect(await token.balanceOf(escrowAddress)).to.equal(
        escrowBalanceBefore - budget - expectedStake,
      );
    });

    it("rejects approval by a caller other than the task's requester", async () => {
      const id = taskId("task-approve-wrong-caller");
      await submitFor(id, budget, 4n);

      await expect(escrow.connect(otherAgent).approveResult(id)).to.be.revertedWithCustomError(
        escrow,
        "NotTaskRequester",
      );
    });

    it("rejects approval when the task is still ACCEPTED (not yet submitted)", async () => {
      const id = taskId("task-approve-still-accepted");
      await createAcceptedTask(id, budget, 5n);

      await expect(escrow.connect(requester).approveResult(id)).to.be.revertedWithCustomError(
        escrow,
        "TaskNotSubmitted",
      );
    });

    it("rejects a second approval once the task is already RELEASED (double-approve)", async () => {
      const id = taskId("task-approve-twice");
      await submitFor(id, budget, 6n);

      await escrow.connect(requester).approveResult(id);

      await expect(escrow.connect(requester).approveResult(id)).to.be.revertedWithCustomError(
        escrow,
        "TaskNotSubmitted",
      );
    });
  });

  describe("claimDeliveryTimeout", () => {
    it("moves ACCEPTED -> REFUNDED after deliveryDeadline, pays budget+stake to requester, and emits DeliveryTimeoutClaimed (F-107)", async () => {
      const id = taskId("task-claim-1");
      await createAcceptedTask(id, budget, 10n, 120); // 2 minutes out

      const task = await escrow.getTask(id);
      const expectedStake = task.stake;

      await ethers.provider.send("evm_increaseTime", [180]); // past the 2-minute deadline
      await ethers.provider.send("evm_mine", []);

      const requesterBalanceBefore = await token.balanceOf(requester.address);
      const escrowBalanceBefore = await token.balanceOf(escrowAddress);

      await expect(escrow.connect(requester).claimDeliveryTimeout(id))
        .to.emit(escrow, "DeliveryTimeoutClaimed")
        .withArgs(id, requester.address, budget, expectedStake);

      const taskAfter = await escrow.getTask(id);
      expect(taskAfter.status).to.equal(5n); // TaskStatus.REFUNDED

      expect(await token.balanceOf(requester.address)).to.equal(
        requesterBalanceBefore + budget + expectedStake,
      );
      expect(await token.balanceOf(escrowAddress)).to.equal(
        escrowBalanceBefore - budget - expectedStake,
      );
    });

    it("rejects a caller other than the task's requester", async () => {
      const id = taskId("task-claim-wrong-caller");
      await createAcceptedTask(id, budget, 11n, 120);

      await ethers.provider.send("evm_increaseTime", [180]);
      await ethers.provider.send("evm_mine", []);

      await expect(escrow.connect(agent).claimDeliveryTimeout(id)).to.be.revertedWithCustomError(
        escrow,
        "NotTaskRequester",
      );
    });

    it("rejects a claim while still before deliveryDeadline", async () => {
      const id = taskId("task-claim-too-early");
      await createAcceptedTask(id, budget, 12n, oneDay);

      await expect(
        escrow.connect(requester).claimDeliveryTimeout(id),
      ).to.be.revertedWithCustomError(escrow, "DeliveryDeadlineNotYetPassed");
    });

    it("rejects a claim when the task is already SUBMITTED (agent delivered in time)", async () => {
      const id = taskId("task-claim-already-submitted");
      await createAcceptedTask(id, budget, 13n, 120);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-in-time"));
      await escrow.connect(agent).submitResult(id, resultHash);

      await ethers.provider.send("evm_increaseTime", [180]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        escrow.connect(requester).claimDeliveryTimeout(id),
      ).to.be.revertedWithCustomError(escrow, "TaskNotAccepted");
    });

    it("succeeds exactly at the deliveryDeadline (>= boundary)", async () => {
      const id = taskId("task-claim-exact-deadline");
      await createAcceptedTask(id, budget, 14n, 120);

      const task = await escrow.getTask(id);
      const exactDeadline = task.deliveryDeadline;

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(exactDeadline)]);

      await expect(escrow.connect(requester).claimDeliveryTimeout(id)).to.not.be.reverted;

      const taskAfter = await escrow.getTask(id);
      expect(taskAfter.status).to.equal(5n); // REFUNDED
    });

    it("submitResult/claimDeliveryTimeout time windows do not overlap and leave no gap", async () => {
      const idBeforeDeadline = taskId("task-window-before-deadline");
      await createAcceptedTask(idBeforeDeadline, budget, 15n, 120);
      const taskBefore = await escrow.getTask(idBeforeDeadline);
      const deadlineBefore = taskBefore.deliveryDeadline;

      // At deliveryDeadline - 1: submitResult succeeds, claimDeliveryTimeout is too early.
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(deadlineBefore) - 1]);
      await expect(
        escrow
          .connect(agent)
          .submitResult(idBeforeDeadline, ethers.keccak256(ethers.toUtf8Bytes("r"))),
      ).to.not.be.reverted;

      await expect(
        escrow.connect(requester).claimDeliveryTimeout(idBeforeDeadline),
      ).to.be.revertedWithCustomError(escrow, "TaskNotAccepted"); // already SUBMITTED by the call above

      const idAtDeadline = taskId("task-window-at-deadline");
      await createAcceptedTask(idAtDeadline, budget, 16n, 120);
      const taskAt = await escrow.getTask(idAtDeadline);
      const deadlineAt = taskAt.deliveryDeadline;

      // At exactly deliveryDeadline: submitResult must reject as too late, claimDeliveryTimeout succeeds.
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(deadlineAt)]);
      await expect(
        escrow.connect(agent).submitResult(idAtDeadline, ethers.keccak256(ethers.toUtf8Bytes("r"))),
      ).to.be.revertedWithCustomError(escrow, "DeliveryDeadlineAlreadyPassed");

      await expect(escrow.connect(requester).claimDeliveryTimeout(idAtDeadline)).to.not.be.reverted;
    });
  });

  describe("finalizeReviewTimeout", () => {
    const submitFor = async (id: string, taskBudget: bigint, nonce: bigint): Promise<void> => {
      await createAcceptedTask(id, taskBudget, nonce);
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`result-${id}`));
      await escrow.connect(agent).submitResult(id, resultHash);
    };

    it("moves SUBMITTED -> RELEASED after reviewDeadline, pays budget+stake to agent, callable by any address (F-108)", async () => {
      const id = taskId("task-finalize-1");
      await submitFor(id, budget, 20n);

      const task = await escrow.getTask(id);
      const expectedStake = task.stake;

      await ethers.provider.send("evm_increaseTime", [reviewWindow + 1]);
      await ethers.provider.send("evm_mine", []);

      const agentBalanceBefore = await token.balanceOf(agent.address);
      const escrowBalanceBefore = await token.balanceOf(escrowAddress);

      // Called by an arbitrary third party (otherAgent), not requester or agent, to prove it's permissionless.
      await expect(escrow.connect(otherAgent).finalizeReviewTimeout(id))
        .to.emit(escrow, "ReviewTimeoutFinalized")
        .withArgs(id, agent.address, budget, expectedStake);

      const taskAfter = await escrow.getTask(id);
      expect(taskAfter.status).to.equal(4n); // TaskStatus.RELEASED

      expect(await token.balanceOf(agent.address)).to.equal(
        agentBalanceBefore + budget + expectedStake,
      );
      expect(await token.balanceOf(escrowAddress)).to.equal(
        escrowBalanceBefore - budget - expectedStake,
      );
    });

    it("rejects finalize while still before reviewDeadline", async () => {
      const id = taskId("task-finalize-too-early");
      await submitFor(id, budget, 21n);

      await expect(
        escrow.connect(otherAgent).finalizeReviewTimeout(id),
      ).to.be.revertedWithCustomError(escrow, "ReviewDeadlineNotYetPassed");
    });

    it("rejects finalize when the task is still ACCEPTED (never submitted)", async () => {
      const id = taskId("task-finalize-still-accepted");
      await createAcceptedTask(id, budget, 22n);

      await expect(
        escrow.connect(otherAgent).finalizeReviewTimeout(id),
      ).to.be.revertedWithCustomError(escrow, "TaskNotSubmitted");
    });

    it("rejects finalize when the task is already RELEASED (already approved)", async () => {
      const id = taskId("task-finalize-already-released");
      await submitFor(id, budget, 23n);
      await escrow.connect(requester).approveResult(id);

      await expect(
        escrow.connect(otherAgent).finalizeReviewTimeout(id),
      ).to.be.revertedWithCustomError(escrow, "TaskNotSubmitted");
    });

    it("rejects a second finalize once the task is already RELEASED via a prior finalize", async () => {
      const id = taskId("task-finalize-twice");
      await submitFor(id, budget, 24n);

      await ethers.provider.send("evm_increaseTime", [reviewWindow + 1]);
      await ethers.provider.send("evm_mine", []);

      await escrow.connect(otherAgent).finalizeReviewTimeout(id);

      await expect(
        escrow.connect(otherAgent).finalizeReviewTimeout(id),
      ).to.be.revertedWithCustomError(escrow, "TaskNotSubmitted");
    });

    it("succeeds exactly at the reviewDeadline (>= boundary)", async () => {
      const id = taskId("task-finalize-exact-deadline");
      await submitFor(id, budget, 25n);

      const task = await escrow.getTask(id);
      const exactReviewDeadline = task.reviewDeadline;

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(exactReviewDeadline)]);

      await expect(escrow.connect(otherAgent).finalizeReviewTimeout(id)).to.not.be.reverted;

      const taskAfter = await escrow.getTask(id);
      expect(taskAfter.status).to.equal(4n); // RELEASED
    });
  });

  describe("constructor reviewWindow validation", () => {
    it("reverts deployment with reviewWindow = 0", async () => {
      const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
      await expect(
        escrowFactory.deploy(tokenAddress, authorizedSigner.address, 0n, arbitrator.address),
      ).to.be.revertedWithCustomError(escrow, "InvalidReviewWindow");
    });

    it("reverts deployment with a reviewWindow that would overflow submittedAt + reviewWindow", async () => {
      const maxUint64 = 2n ** 64n - 1n;
      const tooLarge = maxUint64 / 2n + 1n; // one past the contract's MAX_REVIEW_WINDOW

      const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
      await expect(
        escrowFactory.deploy(tokenAddress, authorizedSigner.address, tooLarge, arbitrator.address),
      ).to.be.revertedWithCustomError(escrow, "InvalidReviewWindow");
    });

    it("accepts deployment with the maximum allowed reviewWindow", async () => {
      const maxUint64 = 2n ** 64n - 1n;
      const maxAllowed = maxUint64 / 2n;

      const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
      const maxEscrow = await escrowFactory.deploy(
        tokenAddress,
        authorizedSigner.address,
        maxAllowed,
        arbitrator.address,
      );
      await expect(maxEscrow.waitForDeployment()).to.not.be.reverted;
      expect(await maxEscrow.reviewWindow()).to.equal(maxAllowed);
    });
  });
});
