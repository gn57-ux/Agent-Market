import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { createChainLogScanner } from "./log-scanner.js";
import { indexBlockRange } from "./indexer.js";
import { findChainIndexedEventsByType } from "./repository.js";

/**
 * T-1805's own real verification requirement (tasks.md): "真实 Hardhat 链上
 * 触发全部 8 种事件，索引服务正确记录" — extended to all 9 real event types
 * `TaskEscrow` currently emits (see decode-any-event.ts's own doc comment
 * for why `TaskCancelled` — Feature 17's later addition — is included
 * rather than artificially excluded).
 *
 * Deliberately drives the contract DIRECTLY (no `apps/api` HTTP layer, no
 * DAG/task business rules) — an indexer only cares about raw contract
 * events, not the application-level rules that lead to them, so testing it
 * through `apps/api`'s endpoints would couple this suite to logic that
 * isn't actually this package's concern. Five independent tasks are used
 * so each of the 9 events can be reached via its own real state-machine
 * path without one task's terminal state blocking another's:
 *   - Task A: fund → accept → submit → approveResult
 *     (TaskFunded, TaskAccepted, ResultSubmitted, ResultApproved)
 *   - Task B: fund → cancel while still OPEN (TaskFunded, TaskCancelled)
 *   - Task C: fund → accept → (no submit) → warp past deliveryDeadline →
 *     claimDeliveryTimeout (TaskFunded, TaskAccepted, DeliveryTimeoutClaimed)
 *   - Task D: fund → accept → submit → warp past reviewDeadline →
 *     finalizeReviewTimeout (TaskFunded, TaskAccepted, ResultSubmitted,
 *     ReviewTimeoutFinalized)
 *   - Task E: fund → accept → submit → openDispute → resolveDispute
 *     (TaskFunded, TaskAccepted, ResultSubmitted, DisputeOpened, DisputeResolved)
 */
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_HARDHAT_E2E_TESTS === "1"
    ? describe
    : describe.skip;

const contractsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../contracts",
);

const HARDHAT_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_REQUESTER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const HARDHAT_AGENT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const HARDHAT_AUTHORIZED_SIGNER_KEY =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const HARDHAT_ARBITRATOR_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

const REVIEW_WINDOW_SECONDS = 259_200n; // 72h — matches this repo's other real e2e deployments.
const DELIVERY_WINDOW_SECONDS = 3600n; // 1h from "now" at task creation.

function readArtifact(relativePath: string): { abi: unknown; bytecode: Hex } {
  const raw = readFileSync(path.join(contractsDir, relativePath), "utf8");
  const parsed = JSON.parse(raw) as { abi: unknown; bytecode: string };
  return { abi: parsed.abi, bytecode: parsed.bytecode as Hex };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("getFreePort: failed to acquire a free TCP port"));
      }
    });
  });
}

async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `waitForRpcReady: hardhat node at ${rpcUrl} never became ready within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

runIfOptedIn(
  "apps/indexer: real Hardhat e2e, all 9 TaskEscrow event types correctly indexed (T-1805)",
  () => {
    let pool: Pool;
    let hardhatProcess: ChildProcessByStdio<null, Readable, Readable>;
    let hardhatStderr = "";
    let rpcUrl: string;
    let ydTokenAddress: `0x${string}`;
    let escrowAddress: `0x${string}`;
    let publicClient: PublicClient;
    let ydTokenAbi: unknown;
    let escrowAbi: unknown;
    let chainId: number;

    const deployer = privateKeyToAccount(HARDHAT_DEPLOYER_KEY);
    const requester = privateKeyToAccount(HARDHAT_REQUESTER_KEY);
    const agent = privateKeyToAccount(HARDHAT_AGENT_KEY);
    const authorizedSigner = privateKeyToAccount(HARDHAT_AUTHORIZED_SIGNER_KEY);
    const arbitrator = privateKeyToAccount(HARDHAT_ARBITRATOR_KEY);

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      const sql = await readFile(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../api/migrations/0028_create_chain_indexed_events.sql",
        ),
        "utf8",
      );
      await pool.query(`DROP TABLE IF EXISTS chain_indexed_events`);
      await pool.query(sql);

      const port = await getFreePort();
      rpcUrl = `http://127.0.0.1:${port}`;
      hardhatProcess = spawn(
        path.join(contractsDir, "node_modules/.bin/hardhat"),
        ["node", "--port", String(port), "--hostname", "127.0.0.1"],
        { cwd: contractsDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      hardhatProcess.stderr.on("data", (chunk: Buffer) => {
        hardhatStderr += chunk.toString();
      });
      const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
        hardhatProcess.once("error", reject);
      });
      try {
        await Promise.race([waitForRpcReady(rpcUrl, 30_000), spawnErrorPromise]);
      } catch (error) {
        throw new Error(`${String(error)}\nhardhat node stderr:\n${hardhatStderr}`);
      }

      publicClient = createPublicClient({ transport: http(rpcUrl) });
      chainId = await publicClient.getChainId();

      const deployerWallet = createWalletClient({ account: deployer, transport: http(rpcUrl) });

      const ydTokenArtifact = readArtifact("artifacts/src/YDToken.sol/YDToken.json");
      ydTokenAbi = ydTokenArtifact.abi;
      const initialSupply = 10_000_000n * 10n ** 18n;
      const ydTokenDeployHash = await deployerWallet.deployContract({
        abi: ydTokenArtifact.abi as never,
        bytecode: ydTokenArtifact.bytecode,
        args: [requester.address, initialSupply],
        chain: null,
      });
      const ydTokenReceipt = await publicClient.waitForTransactionReceipt({
        hash: ydTokenDeployHash,
      });
      if (!ydTokenReceipt.contractAddress)
        throw new Error("YDToken deployment produced no address");
      ydTokenAddress = ydTokenReceipt.contractAddress;

      const taskEscrowArtifact = readArtifact("artifacts/src/TaskEscrow.sol/TaskEscrow.json");
      escrowAbi = taskEscrowArtifact.abi;
      const escrowDeployHash = await deployerWallet.deployContract({
        abi: taskEscrowArtifact.abi as never,
        bytecode: taskEscrowArtifact.bytecode,
        args: [ydTokenAddress, authorizedSigner.address, REVIEW_WINDOW_SECONDS, arbitrator.address],
        chain: null,
      });
      const escrowReceipt = await publicClient.waitForTransactionReceipt({
        hash: escrowDeployHash,
      });
      if (!escrowReceipt.contractAddress)
        throw new Error("TaskEscrow deployment produced no address");
      escrowAddress = escrowReceipt.contractAddress;

      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const seedHash = await requesterWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "transfer",
        args: [agent.address, 1_000_000n * 10n ** 18n],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: seedHash });
    }, 60_000);

    afterAll(async () => {
      hardhatProcess?.kill();
      await pool?.query(`DROP TABLE IF EXISTS chain_indexed_events`);
      await pool?.end();
    });

    let nextPermitNonce = 1n;
    let taskCounter = 0;

    async function createFundedTask(): Promise<{
      taskIdOnChain: `0x${string}`;
      deliveryDeadline: bigint;
    }> {
      taskCounter += 1;
      const taskIdOnChain = ("0x" + taskCounter.toString(16).padStart(64, "0")) as `0x${string}`;
      const budget = 1_000_000_000_000_000_000n;
      const block = await publicClient.getBlock();
      const deliveryDeadline = block.timestamp + DELIVERY_WINDOW_SECONDS;

      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const approveHash = await requesterWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "approve",
        args: [escrowAddress, budget],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const createTaskHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "createTask",
        args: [taskIdOnChain, ydTokenAddress, budget, deliveryDeadline],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: createTaskHash });

      return { taskIdOnChain, deliveryDeadline };
    }

    async function acceptTask(params: {
      taskIdOnChain: `0x${string}`;
      deliveryDeadline: bigint;
    }): Promise<void> {
      nextPermitNonce += 1n;
      const permit = {
        taskId: params.taskIdOnChain,
        agent: agent.address,
        nonce: nextPermitNonce,
        expiry: params.deliveryDeadline,
        chainId: BigInt(chainId),
        verifyingContract: escrowAddress,
      };
      const permitSignature = await authorizedSigner.signTypedData({
        domain: {
          name: "AgentMarketTaskEscrow",
          version: "1",
          chainId,
          verifyingContract: escrowAddress,
        },
        types: {
          AcceptancePermit: [
            { name: "taskId", type: "bytes32" },
            { name: "agent", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "expiry", type: "uint256" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
        primaryType: "AcceptancePermit",
        message: permit,
      });

      const agentWallet = createWalletClient({ account: agent, transport: http(rpcUrl) });
      const stakeApproveHash = await agentWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "approve",
        args: [escrowAddress, 1_000_000_000_000_000_000n],
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: stakeApproveHash });

      const acceptHash = await agentWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "acceptTask",
        args: [permit, permitSignature],
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: acceptHash });
    }

    async function submitTaskResult(taskIdOnChain: `0x${string}`): Promise<void> {
      const agentWallet = createWalletClient({ account: agent, transport: http(rpcUrl) });
      const resultHash = ("0x" + "11".repeat(32)) as `0x${string}`;
      const submitHash = await agentWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "submitResult",
        args: [taskIdOnChain, resultHash],
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: submitHash });
    }

    const rawRequest = (params: { method: string; params: unknown[] }) =>
      (publicClient.request as (args: unknown) => Promise<unknown>)(params);

    async function increaseChainTime(seconds: bigint): Promise<void> {
      await rawRequest({ method: "evm_increaseTime", params: [Number(seconds)] });
      await rawRequest({ method: "evm_mine", params: [] });
    }

    it("real Hardhat e2e: 5 tasks trigger all 9 TaskEscrow event types; the indexer scans and records every one exactly once", async () => {
      // Task A: TaskFunded, TaskAccepted, ResultSubmitted, ResultApproved
      const taskA = await createFundedTask();
      await acceptTask(taskA);
      await submitTaskResult(taskA.taskIdOnChain);
      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const approveResultHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "approveResult",
        args: [taskA.taskIdOnChain],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveResultHash });

      // Task B: TaskFunded, TaskCancelled
      const taskB = await createFundedTask();
      const cancelHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "cancelTask",
        args: [taskB.taskIdOnChain],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: cancelHash });

      // Task C: TaskFunded, TaskAccepted, DeliveryTimeoutClaimed
      const taskC = await createFundedTask();
      await acceptTask(taskC);
      await increaseChainTime(DELIVERY_WINDOW_SECONDS + 10n);
      const claimTimeoutHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "claimDeliveryTimeout",
        args: [taskC.taskIdOnChain],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: claimTimeoutHash });

      // Task D: TaskFunded, TaskAccepted, ResultSubmitted, ReviewTimeoutFinalized
      const taskD = await createFundedTask();
      await acceptTask(taskD);
      await submitTaskResult(taskD.taskIdOnChain);
      await increaseChainTime(REVIEW_WINDOW_SECONDS + 10n);
      const finalizeHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "finalizeReviewTimeout",
        args: [taskD.taskIdOnChain],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: finalizeHash });

      // Task E: TaskFunded, TaskAccepted, ResultSubmitted, DisputeOpened, DisputeResolved
      const taskE = await createFundedTask();
      await acceptTask(taskE);
      await submitTaskResult(taskE.taskIdOnChain);
      const evidenceHash = ("0x" + "22".repeat(32)) as `0x${string}`;
      const openDisputeHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "openDispute",
        args: [taskE.taskIdOnChain, evidenceHash],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: openDisputeHash });

      const arbitratorWallet = createWalletClient({
        account: arbitrator,
        transport: http(rpcUrl),
      });
      const resolveDisputeHash = await arbitratorWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "resolveDispute",
        args: [taskE.taskIdOnChain, true],
        chain: null,
        account: arbitrator,
      });
      await publicClient.waitForTransactionReceipt({ hash: resolveDisputeHash });

      // --- Now run the actual indexer under test over the full range ---
      const scanner = createChainLogScanner({ BACKEND_RPC_URL: rpcUrl } as NodeJS.ProcessEnv);
      const latestBlock = await publicClient.getBlockNumber();
      const result = await indexBlockRange({
        scanner,
        client: pool,
        chainId,
        contractAddress: escrowAddress,
        fromBlock: 0n,
        toBlock: latestBlock,
      });

      // The 2 undecoded logs are real, expected, and correct: OpenZeppelin
      // `AccessControl`'s own `RoleGranted` events, emitted twice by
      // `TaskEscrow`'s constructor (deployer's DEFAULT_ADMIN_ROLE,
      // arbitrator's ARBITRATOR_ROLE) — genuine logs from the escrow
      // contract's own address, but not one of F-1807's 9 business event
      // types. `decodeAnyEvent` correctly falls through to `null` for
      // them rather than misclassifying them as one of the 9; a scanner
      // starting from a real deployment block in production would see
      // the same 2 logs at that height for the same reason.
      expect(result.logsUndecoded).toBe(2);
      // Task A: TaskFunded+TaskAccepted+ResultSubmitted+ResultApproved (4)
      // Task B: TaskFunded+TaskCancelled (2)
      // Task C: TaskFunded+TaskAccepted+DeliveryTimeoutClaimed (3)
      // Task D: TaskFunded+TaskAccepted+ResultSubmitted+ReviewTimeoutFinalized (4)
      // Task E: TaskFunded+TaskAccepted+ResultSubmitted+DisputeOpened+DisputeResolved (5)
      expect(result.eventsIndexed).toBe(18);

      const eventTypes = [
        "TaskFunded",
        "TaskAccepted",
        "ResultSubmitted",
        "ResultApproved",
        "DeliveryTimeoutClaimed",
        "ReviewTimeoutFinalized",
        "DisputeOpened",
        "DisputeResolved",
        "TaskCancelled",
      ];
      for (const eventType of eventTypes) {
        const rows = await findChainIndexedEventsByType(pool, { chainId, eventType });
        expect(rows.length, `expected at least one indexed ${eventType} row`).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.confirmationStatus).toBe("PENDING_CONFIRMATION");
        }
      }

      // Re-running the same range is idempotent: no new rows, no error.
      const secondPass = await indexBlockRange({
        scanner,
        client: pool,
        chainId,
        contractAddress: escrowAddress,
        fromBlock: 0n,
        toBlock: latestBlock,
      });
      expect(secondPass.eventsIndexed).toBe(0);
      expect(secondPass.logsScanned).toBe(result.logsScanned);
    }, 60_000);
  },
);
