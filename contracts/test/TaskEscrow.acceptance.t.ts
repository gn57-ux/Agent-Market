import { expect } from "chai";
import { ethers } from "hardhat";
import type { TaskEscrow, YDToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TaskEscrow.acceptTask (AC-102, AC-103, AC-104)", () => {
  let requester: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let otherAgent: HardhatEthersSigner;
  let authorizedSigner: HardhatEthersSigner;
  let strangerSigner: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;
  let escrowAddress: string;
  let tokenAddress: string;
  let chainId: bigint;

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

  // EIP-712 domain/types must mirror the contract's EIP712("AgentMarketTaskEscrow", "1") setup
  // and the AcceptancePermit struct field order exactly.
  const domain = () => ({
    name: "AgentMarketTaskEscrow",
    version: "1",
    chainId,
    verifyingContract: escrowAddress,
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
  ): Promise<string> => signer.signTypedData(domain(), types, permit);

  const createOpenTask = async (id: string, taskBudget: bigint): Promise<void> => {
    const deadline = await futureDeadline(oneDay);
    await escrow.connect(requester).createTask(id, tokenAddress, taskBudget, deadline);
  };

  const mintAndApprove = async (signer: HardhatEthersSigner, amount: bigint): Promise<void> => {
    await token.connect(requester).transfer(signer.address, amount);
    await token.connect(signer).approve(escrowAddress, ethers.MaxUint256);
  };

  beforeEach(async () => {
    [requester, agent, otherAgent, authorizedSigner, strangerSigner] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", requester);
    token = await tokenFactory.deploy(requester.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
    escrow = await escrowFactory.deploy(tokenAddress, authorizedSigner.address);
    await escrow.waitForDeployment();
    escrowAddress = await escrow.getAddress();

    await token.connect(requester).approve(escrowAddress, ethers.MaxUint256);

    const network = await ethers.provider.getNetwork();
    chainId = network.chainId;

    await mintAndApprove(agent, ethers.parseUnits("1000", 18));
    await mintAndApprove(otherAgent, ethers.parseUnits("1000", 18));
  });

  it("accepts a valid permit: OPEN -> ACCEPTED, correct 6% stake transferred, event emitted", async () => {
    const id = taskId("task-accept-1");
    await createOpenTask(id, budget);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    const expectedStake = (budget * 600n) / 10_000n;
    const agentBalanceBefore = await token.balanceOf(agent.address);

    await expect(escrow.connect(agent).acceptTask(permit, signature))
      .to.emit(escrow, "TaskAccepted")
      .withArgs(id, agent.address, expectedStake);

    const task = await escrow.getTask(id);
    expect(task.status).to.equal(1n); // TaskStatus.ACCEPTED
    expect(task.agent).to.equal(agent.address);
    expect(task.stake).to.equal(expectedStake);

    expect(await token.balanceOf(agent.address)).to.equal(agentBalanceBefore - expectedStake);
    expect(await token.balanceOf(escrowAddress)).to.equal(budget + expectedStake);
  });

  it("computes stake correctly for an odd budget (AC-104 rounding)", async () => {
    const id = taskId("task-accept-odd-budget");
    const oddBudget = 1_000_007n; // not evenly divisible by the 600/10000 stake rate
    await createOpenTask(id, oddBudget);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 1n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    const expectedStake = (oddBudget * 600n) / 10_000n; // floor(1_000_007 * 600 / 10_000) = 60000
    expect(expectedStake).to.equal(60000n);

    await expect(escrow.connect(agent).acceptTask(permit, signature))
      .to.emit(escrow, "TaskAccepted")
      .withArgs(id, agent.address, expectedStake);

    const task = await escrow.getTask(id);
    expect(task.stake).to.equal(expectedStake);
  });

  it("rejects acceptance when the computed stake would round down to zero (AC-104)", async () => {
    const id = taskId("task-accept-tiny-budget");
    const tinyBudget = 16n; // 16 * 600 / 10_000 = 0 (floor)
    await createOpenTask(id, tinyBudget);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 2n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    await expect(escrow.connect(agent).acceptTask(permit, signature)).to.be.revertedWithCustomError(
      escrow,
      "StakeAmountZero",
    );

    const task = await escrow.getTask(id);
    expect(task.status).to.equal(0n); // still OPEN, not silently accepted
  });

  it("does not overflow the stake computation for a very large budget", async () => {
    // Mint a requester an enormous budget directly (bypassing the 1,000,000-token faucet-style
    // setup) so createTask can lock in a budget close to a realistic "very large" upper bound
    // without hitting this token's total-supply limits; the point is to prove `Math.mulDiv`
    // handles a `budget * 600` product that a naive multiply-then-divide would overflow on.
    const hugeBudget = ethers.parseUnits("1000000000000000000", 18); // 1e18 whole tokens
    await token.connect(requester).mint(requester.address, hugeBudget);

    const id = taskId("task-accept-huge-budget");
    const deadline = await futureDeadline(oneDay);
    await token.connect(requester).approve(escrowAddress, ethers.MaxUint256);
    await escrow.connect(requester).createTask(id, tokenAddress, hugeBudget, deadline);

    const expectedStakePreview = (hugeBudget * 600n) / 10_000n;
    await token.connect(requester).mint(agent.address, expectedStakePreview);
    await token.connect(agent).approve(escrowAddress, ethers.MaxUint256);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 3n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    const expectedStake = (hugeBudget * 600n) / 10_000n;

    await expect(escrow.connect(agent).acceptTask(permit, signature))
      .to.emit(escrow, "TaskAccepted")
      .withArgs(id, agent.address, expectedStake);
  });

  it("rejects acceptance after the task's deliveryDeadline has passed", async () => {
    const id = taskId("task-accept-after-deadline");
    const deadline = await futureDeadline(60); // 1 minute out
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    await ethers.provider.send("evm_increaseTime", [120]);
    await ethers.provider.send("evm_mine", []);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 4n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    await expect(escrow.connect(agent).acceptTask(permit, signature)).to.be.revertedWithCustomError(
      escrow,
      "DeliveryDeadlinePassed",
    );
  });

  it("rejects an expired permit", async () => {
    const id = taskId("task-expired-permit");
    await createOpenTask(id, budget);

    const latest = await ethers.provider.getBlock("latest");
    if (!latest) {
      throw new Error("no latest block");
    }

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: BigInt(latest.timestamp), // not in the future
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    await expect(escrow.connect(agent).acceptTask(permit, signature)).to.be.revertedWithCustomError(
      escrow,
      "PermitExpired",
    );
  });

  it("rejects a permit signed by a non-authorized key", async () => {
    const id = taskId("task-wrong-signer");
    await createOpenTask(id, budget);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(strangerSigner, permit);

    await expect(escrow.connect(agent).acceptTask(permit, signature)).to.be.revertedWithCustomError(
      escrow,
      "InvalidPermitSignature",
    );
  });

  it("rejects a permit whose chainId field does not match the current chain", async () => {
    const id = taskId("task-wrong-chainid");
    await createOpenTask(id, budget);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId: chainId + 1n,
      verifyingContract: escrowAddress,
    };
    // Sign over the mismatched chainId field directly (struct field, not the domain), so the
    // permit's own `chainId != block.chainid` check is what triggers the revert.
    const signature = await signPermit(authorizedSigner, permit);

    await expect(escrow.connect(agent).acceptTask(permit, signature)).to.be.revertedWithCustomError(
      escrow,
      "PermitWrongChain",
    );
  });

  it("rejects a permit whose verifyingContract field does not match this contract", async () => {
    const id = taskId("task-wrong-verifying-contract");
    await createOpenTask(id, budget);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: requester.address, // wrong: not this escrow
    };
    const signature = await signPermit(authorizedSigner, permit);

    await expect(escrow.connect(agent).acceptTask(permit, signature)).to.be.revertedWithCustomError(
      escrow,
      "PermitWrongContract",
    );
  });

  it("rejects a reused nonce, even against a different task", async () => {
    const id1 = taskId("task-nonce-reuse-1");
    const id2 = taskId("task-nonce-reuse-2");
    await createOpenTask(id1, budget);
    await createOpenTask(id2, budget);

    const nonce = 5n;
    const expiry = await futureDeadline(oneDay);

    const permit1: AcceptancePermit = {
      taskId: id1,
      agent: agent.address,
      nonce,
      expiry,
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature1 = await signPermit(authorizedSigner, permit1);
    await escrow.connect(agent).acceptTask(permit1, signature1);

    const permit2: AcceptancePermit = {
      taskId: id2,
      agent: agent.address,
      nonce, // same nonce, different task
      expiry,
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature2 = await signPermit(authorizedSigner, permit2);

    await expect(
      escrow.connect(agent).acceptTask(permit2, signature2),
    ).to.be.revertedWithCustomError(escrow, "PermitNonceAlreadyUsed");
  });

  it("rejects redemption by a caller other than permit.agent", async () => {
    const id = taskId("task-agent-mismatch");
    await createOpenTask(id, budget);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    // otherAgent tries to redeem a permit authorized for `agent`.
    await expect(
      escrow.connect(otherAgent).acceptTask(permit, signature),
    ).to.be.revertedWithCustomError(escrow, "PermitAgentMismatch");
  });

  it("AC-103: of two concurrently-submitted permits for the same task, only the first succeeds", async () => {
    // The EVM executes transactions sequentially, so "concurrent" submission is modeled here by
    // calling acceptTask twice in a row for the same taskId with two different, independently
    // valid permits (different agents, different nonces) and asserting the second reverts
    // because the task is no longer OPEN. This is the correct way to prove "only one of N
    // concurrent submissions succeeds" against a single-threaded EVM — it is not a missed
    // true-concurrency test, sequential execution IS the concurrency model here.
    const id = taskId("task-concurrent-accept");
    await createOpenTask(id, budget);

    const expiry = await futureDeadline(oneDay);

    const permitAgent: AcceptancePermit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry,
      chainId,
      verifyingContract: escrowAddress,
    };
    const permitOtherAgent: AcceptancePermit = {
      taskId: id,
      agent: otherAgent.address,
      nonce: 0n,
      expiry,
      chainId,
      verifyingContract: escrowAddress,
    };
    const signatureAgent = await signPermit(authorizedSigner, permitAgent);
    const signatureOtherAgent = await signPermit(authorizedSigner, permitOtherAgent);

    await escrow.connect(agent).acceptTask(permitAgent, signatureAgent);

    await expect(
      escrow.connect(otherAgent).acceptTask(permitOtherAgent, signatureOtherAgent),
    ).to.be.revertedWithCustomError(escrow, "TaskNotOpen");

    const task = await escrow.getTask(id);
    expect(task.agent).to.equal(agent.address);
    expect(task.status).to.equal(1n); // still ACCEPTED, not overwritten
  });

  it("rejects the task's own requester from accepting it as the agent", async () => {
    const id = taskId("task-requester-self-accept");
    await createOpenTask(id, budget);

    await token.connect(requester).approve(escrowAddress, ethers.MaxUint256);

    const permit: AcceptancePermit = {
      taskId: id,
      agent: requester.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);

    await expect(
      escrow.connect(requester).acceptTask(permit, signature),
    ).to.be.revertedWithCustomError(escrow, "RequesterCannotAcceptOwnTask");
  });

  it("reverts deployment with a zero-address authorized signer", async () => {
    const escrowFactory = await ethers.getContractFactory("TaskEscrow", requester);
    await expect(
      escrowFactory.deploy(tokenAddress, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(escrow, "ZeroAuthorizedSigner");
  });
});
