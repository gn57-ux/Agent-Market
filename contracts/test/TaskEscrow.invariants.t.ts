import { expect } from "chai";
import { ethers } from "hardhat";
import type { TaskEscrow, YDToken } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// AC-110: "每个终态（RELEASED/REFUNDED/CANCELLED）下合约余额与任务资金守恒（不变量测试）".
// This file proves fund conservation holds for every terminal path, individually and under
// interleaved multi-task concurrency, and specifically at the integer-rounding boundaries
// (smallest non-zero stake budget, near-overflow budget) called out in the risk notes.
describe("TaskEscrow fund conservation invariants (AC-110)", () => {
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

  const createOpenTask = async (
    id: string,
    taskBudget: bigint,
    deadlineOffsetSeconds: number = oneDay,
  ): Promise<void> => {
    const deadline = await futureDeadline(deadlineOffsetSeconds);
    await escrow.connect(requester).createTask(id, tokenAddress, taskBudget, deadline);
  };

  const acceptTaskAs = async (
    id: string,
    acceptor: HardhatEthersSigner,
    nonce: bigint,
  ): Promise<void> => {
    const permit: AcceptancePermit = {
      taskId: id,
      agent: acceptor.address,
      nonce,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await signPermit(authorizedSigner, permit);
    await escrow.connect(acceptor).acceptTask(permit, signature);
  };

  const createAcceptedTask = async (
    id: string,
    taskBudget: bigint,
    nonce: bigint,
    deadlineOffsetSeconds: number = oneDay,
  ): Promise<void> => {
    await createOpenTask(id, taskBudget, deadlineOffsetSeconds);
    await acceptTaskAs(id, agent, nonce);
  };

  const createSubmittedTask = async (
    id: string,
    taskBudget: bigint,
    nonce: bigint,
  ): Promise<void> => {
    await createAcceptedTask(id, taskBudget, nonce);
    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`result-${id}`));
    await escrow.connect(agent).submitResult(id, resultHash);
  };

  // Snapshots the three parties whose balances must sum to a constant across a terminal
  // transition (AC-110's conservation clause): requester, agent, and the escrow itself.
  interface Balances {
    requester: bigint;
    agent: bigint;
    escrow: bigint;
  }

  const snapshotBalances = async (): Promise<Balances> => ({
    requester: await token.balanceOf(requester.address),
    agent: await token.balanceOf(agent.address),
    escrow: await token.balanceOf(escrowAddress),
  });

  const sumBalances = (b: Balances): bigint => b.requester + b.agent + b.escrow;

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

  describe("single-task terminal-path conservation", () => {
    it("RELEASED via approveResult: escrow balance drops by exactly budget+stake, 3-party sum unchanged", async () => {
      const id = taskId("inv-approve");
      await createSubmittedTask(id, budget, 0n);
      const task = await escrow.getTask(id);
      const payout = task.budget + task.stake;

      const before = await snapshotBalances();
      await escrow.connect(requester).approveResult(id);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });

    it("RELEASED via finalizeReviewTimeout: escrow balance drops by exactly budget+stake, sum unchanged", async () => {
      const id = taskId("inv-finalize-timeout");
      await createSubmittedTask(id, budget, 1n);
      const task = await escrow.getTask(id);
      const payout = task.budget + task.stake;

      await ethers.provider.send("evm_increaseTime", [reviewWindow + 1]);
      await ethers.provider.send("evm_mine", []);

      const before = await snapshotBalances();
      await escrow.connect(otherAgent).finalizeReviewTimeout(id);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });

    it("RELEASED via resolveDispute(supportAgent=true): escrow balance drops by exactly budget+stake, sum unchanged", async () => {
      const id = taskId("inv-dispute-support-agent");
      await createSubmittedTask(id, budget, 2n);
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
      await escrow.connect(requester).openDispute(id, evidenceHash);
      const task = await escrow.getTask(id);
      const payout = task.budget + task.stake;

      const before = await snapshotBalances();
      await escrow.connect(arbitrator).resolveDispute(id, true);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });

    it("REFUNDED via claimDeliveryTimeout: escrow balance drops by exactly budget+stake, sum unchanged", async () => {
      const id = taskId("inv-delivery-timeout");
      await createAcceptedTask(id, budget, 3n, 100);
      const task = await escrow.getTask(id);
      const payout = task.budget + task.stake;

      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      const before = await snapshotBalances();
      await escrow.connect(requester).claimDeliveryTimeout(id);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });

    it("REFUNDED via resolveDispute(supportAgent=false): escrow balance drops by exactly budget+stake, sum unchanged", async () => {
      const id = taskId("inv-dispute-support-requester");
      await createSubmittedTask(id, budget, 4n);
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
      await escrow.connect(requester).openDispute(id, evidenceHash);
      const task = await escrow.getTask(id);
      const payout = task.budget + task.stake;

      const before = await snapshotBalances();
      await escrow.connect(arbitrator).resolveDispute(id, false);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });

    it("CANCELLED via cancelTask: escrow balance drops by exactly budget (no stake locked), sum unchanged", async () => {
      const id = taskId("inv-cancel");
      await createOpenTask(id, budget);
      const task = await escrow.getTask(id);
      expect(task.stake).to.equal(0n);
      const payout = task.budget;

      const before = await snapshotBalances();
      await escrow.connect(requester).cancelTask(id);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });
  });

  describe("boundary-value conservation (T-108: end-to-end, not just stake computation)", () => {
    it("smallest budget producing a non-zero stake (budget=17): full approveResult settlement conserves funds", async () => {
      const tinyBudget = 17n; // floor(17 * 600 / 10_000) = 1, the smallest non-zero stake
      const id = taskId("inv-boundary-tiny-budget");
      await createOpenTask(id, tinyBudget);
      await acceptTaskAs(id, agent, 10n);

      const task = await escrow.getTask(id);
      expect(task.stake).to.equal(1n);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-tiny"));
      await escrow.connect(agent).submitResult(id, resultHash);

      const payout = task.budget + task.stake;
      const before = await snapshotBalances();
      await escrow.connect(requester).approveResult(id);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });

    it("budget just above type(uint256).max / 600 (overflow boundary): full approveResult settlement conserves funds", async () => {
      // Mirrors T-103's overflow boundary test exactly: a budget above this threshold would
      // overflow a naive `budget * STAKE_RATE_BPS` multiply; Math.mulDiv must not. T-108's job is
      // to confirm the *full settlement* (not just the stake number) still conserves funds here.
      const maxUint256 = 2n ** 256n - 1n;
      const overflowThreshold = maxUint256 / 600n;
      const hugeBudget = overflowThreshold + 1_000n;
      const expectedStake = (hugeBudget * 600n) / 10_000n;

      await token.connect(requester).mint(requester.address, hugeBudget);
      await token.connect(requester).mint(agent.address, expectedStake);

      const id = taskId("inv-boundary-huge-budget");
      const deadline = await futureDeadline(oneDay);
      await escrow.connect(requester).createTask(id, tokenAddress, hugeBudget, deadline);
      await acceptTaskAs(id, agent, 11n);

      const task = await escrow.getTask(id);
      expect(task.stake).to.equal(expectedStake);

      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result-huge"));
      await escrow.connect(agent).submitResult(id, resultHash);

      const payout = task.budget + task.stake;
      const before = await snapshotBalances();
      await escrow.connect(requester).approveResult(id);
      const after = await snapshotBalances();

      expect(before.escrow - after.escrow).to.equal(payout);
      expect(sumBalances(after)).to.equal(sumBalances(before));
    });
  });

  describe("multi-task interleaving: escrow balance == sum locked across all active tasks", () => {
    it("drives 4 tasks through 4 different terminal paths in interleaved order, checking conservation at every step", async () => {
      const idA = taskId("inv-multi-A-approve");
      const idB = taskId("inv-multi-B-delivery-timeout");
      const idC = taskId("inv-multi-C-cancel");
      const idD = taskId("inv-multi-D-dispute-support-agent");

      const budgetA = ethers.parseUnits("50", 18);
      const budgetB = ethers.parseUnits("30", 18);
      const budgetC = ethers.parseUnits("20", 18);
      const budgetD = ethers.parseUnits("40", 18);

      // Tracks what the escrow SHOULD be holding for each still-non-terminal task: budget only
      // while OPEN (no stake locked yet), budget+stake once ACCEPTED/SUBMITTED/DISPUTED. Removed
      // entirely once a task reaches a terminal state, proving that one task's settlement never
      // touches funds locked for a different, still-active task (T-102's shared-contract design).
      const locked = new Map<string, bigint>();

      const assertConserved = async (): Promise<void> => {
        let expectedEscrowBalance = 0n;
        for (const amount of locked.values()) {
          expectedEscrowBalance += amount;
        }
        expect(await token.balanceOf(escrowAddress)).to.equal(expectedEscrowBalance);
      };

      // 1. Create all four tasks (interleaved with each other, not grouped by eventual path).
      // B gets a short delivery window so it can be driven to REFUNDED via timeout later without
      // waiting anywhere near A/D's 72h review window.
      await createOpenTask(idA, budgetA, oneDay);
      locked.set(idA, budgetA);
      await createOpenTask(idB, budgetB, 1000);
      locked.set(idB, budgetB);
      await createOpenTask(idC, budgetC, oneDay);
      locked.set(idC, budgetC);
      await createOpenTask(idD, budgetD, oneDay);
      locked.set(idD, budgetD);
      await assertConserved();

      // 2. Accept A, B, and D (interleaved); C is left OPEN so it can be cancelled instead.
      await acceptTaskAs(idA, agent, 20n);
      locked.set(idA, (await escrow.getTask(idA)).budget + (await escrow.getTask(idA)).stake);
      await acceptTaskAs(idB, agent, 21n);
      locked.set(idB, (await escrow.getTask(idB)).budget + (await escrow.getTask(idB)).stake);
      await acceptTaskAs(idD, agent, 22n);
      locked.set(idD, (await escrow.getTask(idD)).budget + (await escrow.getTask(idD)).stake);
      await assertConserved();

      // 3. Cancel C while A, B, D are still in progress: C's refund must not disturb the others'
      // still-locked funds.
      await escrow.connect(requester).cancelTask(idC);
      locked.delete(idC);
      await assertConserved();

      // 4. Submit results for A and D (interleaved), then open a dispute on D. B is deliberately
      // never submitted, so it stays eligible for a delivery timeout below.
      await escrow
        .connect(agent)
        .submitResult(idA, ethers.keccak256(ethers.toUtf8Bytes("result-A")));
      await assertConserved();
      await escrow
        .connect(agent)
        .submitResult(idD, ethers.keccak256(ethers.toUtf8Bytes("result-D")));
      await assertConserved();
      await escrow
        .connect(requester)
        .openDispute(idD, ethers.keccak256(ethers.toUtf8Bytes("evidence-D")));
      await assertConserved(); // openDispute moves no funds

      // 5. Advance time past B's short delivery deadline only (well under A/D's 72h review
      // window), then claim B's delivery timeout.
      await ethers.provider.send("evm_increaseTime", [1100]);
      await ethers.provider.send("evm_mine", []);
      await escrow.connect(requester).claimDeliveryTimeout(idB);
      locked.delete(idB);
      await assertConserved();

      // 6. Resolve D's dispute in the agent's favor.
      await escrow.connect(arbitrator).resolveDispute(idD, true);
      locked.delete(idD);
      await assertConserved();

      // 7. Finally approve A. After this, no task remains active and the escrow must be drained
      // to exactly zero.
      await escrow.connect(requester).approveResult(idA);
      locked.delete(idA);
      await assertConserved();
      expect(await token.balanceOf(escrowAddress)).to.equal(0n);
    });
  });
});
