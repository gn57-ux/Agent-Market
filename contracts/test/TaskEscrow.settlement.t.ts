import { expect } from "chai";
import { ethers } from "hardhat";
import type { TaskEscrow, YDToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TaskEscrow.submitResult / approveResult (AC-105, AC-106, AC-112)", () => {
  let requester: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let otherAgent: HardhatEthersSigner;
  let authorizedSigner: HardhatEthersSigner;
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
    [requester, agent, otherAgent, authorizedSigner] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", requester);
    token = await tokenFactory.deploy(requester.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
    escrow = await escrowFactory.deploy(tokenAddress, authorizedSigner.address, reviewWindow);
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
});
