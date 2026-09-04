import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { createChainLogScanner } from "./log-scanner.js";
import { confirmIndexedEvents, indexBlockRange } from "./indexer.js";
import {
  findChainIndexedEventsByType,
  findLastConfirmedBlockNumber,
  findScanCheckpoint,
  upsertScanCheckpoint,
} from "./repository.js";

/**
 * AC-1806's real full-flow proof: a real Hardhat chain, a real
 * `TaskEscrow` deployment, and a genuine two-"run" simulation — the
 * SECOND `indexBlockRange` call resumes from EXACTLY
 * `findLastConfirmedBlockNumber() + 1`, the same real breakpoint query
 * `main.ts`'s own startup logic uses — proving all three of AC-1806's own
 * claims together: (a) resumes from a real persisted breakpoint, (b) does
 * not re-write already-indexed events (the shared `UNIQUE` constraint,
 * already proven at the repository level — this test additionally proves
 * it holds across a real restart boundary, not just a synthetic re-call),
 * (c) does not miss events genuinely produced while the "first run" was
 * not scanning (simulated here by creating a second real on-chain task
 * AFTER the first indexing pass, before the second one starts).
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
const HARDHAT_AUTHORIZED_SIGNER_KEY =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const HARDHAT_ARBITRATOR_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

const REVIEW_WINDOW_SECONDS = 259_200n;
const DELIVERY_WINDOW_SECONDS = 3600n;

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

runIfOptedIn("apps/indexer: breakpoint resume across a real simulated restart (T-1806)", () => {
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
  const authorizedSigner = privateKeyToAccount(HARDHAT_AUTHORIZED_SIGNER_KEY);
  const arbitrator = privateKeyToAccount(HARDHAT_ARBITRATOR_KEY);

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    const chainIndexedEventsSql = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../api/migrations/0028_create_chain_indexed_events.sql",
      ),
      "utf8",
    );
    await pool.query(`DROP TABLE IF EXISTS chain_indexed_events`);
    await pool.query(chainIndexedEventsSql);

    const scanCheckpointsSql = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../api/migrations/0030_create_indexer_scan_checkpoints.sql",
      ),
      "utf8",
    );
    await pool.query(`DROP TABLE IF EXISTS indexer_scan_checkpoints`);
    await pool.query(scanCheckpointsSql);

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
    if (!ydTokenReceipt.contractAddress) throw new Error("YDToken deployment produced no address");
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
  }, 60_000);

  afterAll(async () => {
    hardhatProcess?.kill();
    await pool?.query(`DROP TABLE IF EXISTS chain_indexed_events`);
    await pool?.query(`DROP TABLE IF EXISTS indexer_scan_checkpoints`);
    await pool?.end();
  });

  // Each `it` below funds real on-chain tasks against the SAME shared
  // Hardhat chain/DB and asserts an exact row count for its own chainId —
  // without this, a second test's rows would accumulate on top of the
  // first's and break that count.
  afterEach(async () => {
    await pool.query("DELETE FROM chain_indexed_events");
    await pool.query("DELETE FROM indexer_scan_checkpoints");
  });

  let taskCounter = 0;

  async function fundTask(): Promise<bigint> {
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
    const createTaskReceipt = await publicClient.waitForTransactionReceipt({
      hash: createTaskHash,
    });
    // Returning the receipt's OWN blockNumber, not a separate
    // getBlockNumber() call — viem's PublicClient caches getBlockNumber()
    // results for a few seconds by default, which (a real bug this test
    // itself first caught) makes a SECOND call issued shortly after new
    // blocks were mined silently return a STALE height. The receipt's
    // blockNumber has no such ambiguity: it is the exact, real block this
    // specific transaction was mined into.
    return createTaskReceipt.blockNumber;
  }

  it("resumes indexing from the real persisted breakpoint and indexes every event exactly once across a simulated restart", async () => {
    const scanner = createChainLogScanner({ BACKEND_RPC_URL: rpcUrl } as NodeJS.ProcessEnv);
    const confirmationDepth = 0n; // deterministic and fast — the specific number is Q-1803's own open question, irrelevant to proving the mechanism.

    // --- "Run 1": fund task 1, index it, confirm it. ---
    const blockAfterTask1 = await fundTask();
    const firstPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: 0n,
      toBlock: blockAfterTask1,
    });
    expect(firstPass.eventsIndexed).toBeGreaterThanOrEqual(1);
    await upsertScanCheckpoint(pool, { chainId, lastScannedBlock: blockAfterTask1 });
    await confirmIndexedEvents({
      client: pool,
      chainId,
      latestBlock: blockAfterTask1,
      confirmationDepth,
    });

    const breakpointAfterRun1 = await findScanCheckpoint(pool, chainId);
    expect(breakpointAfterRun1).not.toBeNull();

    // --- "Downtime": task 2 is funded while nothing is scanning. ---
    const blockAfterTask2 = await fundTask();

    // --- "Run 2" (simulated restart): resume from the real scan
    // checkpoint, exactly as main.ts's own startup logic does (the
    // PRIMARY resume signal — see main.ts's own header comment for why,
    // round 2's own N4 finding). ---
    const resumedFrom = (breakpointAfterRun1 ?? 0n) + 1n;
    const secondPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: resumedFrom,
      toBlock: blockAfterTask2,
    });
    // Only task 2's own (real, new) event is found in this range —
    // task 1's was already indexed in run 1 and is correctly NOT
    // re-scanned (the range starts strictly after it).
    expect(secondPass.eventsIndexed).toBe(1);
    await upsertScanCheckpoint(pool, { chainId, lastScannedBlock: blockAfterTask2 });
    await confirmIndexedEvents({
      client: pool,
      chainId,
      latestBlock: blockAfterTask2,
      confirmationDepth,
    });

    // Both tasks' TaskFunded events are indexed, exactly once each,
    // both eventually CONFIRMED — nothing lost, nothing duplicated.
    const rows = await findChainIndexedEventsByType(pool, { chainId, eventType: "TaskFunded" });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.confirmationStatus === "CONFIRMED")).toBe(true);
    const uniqueTxHashes = new Set(rows.map((row) => row.txHash));
    expect(uniqueTxHashes.size).toBe(2);
  }, 30_000);

  /**
   * T-1806 round 2 (N4 real P2 fix): the test above always confirms
   * before its simulated restart, so it never exercises the exact gap
   * round 1's own N4 finding caught — a restart BEFORE anything has ever
   * been confirmed. This test reproduces that gap directly: a
   * `confirmationDepth` high enough that nothing is ever promoted to
   * CONFIRMED, proving `findLastConfirmedBlockNumber()` stays `null`
   * throughout while `findScanCheckpoint()` alone still correctly drives
   * the resume — the exact scenario `main.ts`'s own startup logic must
   * get right.
   */
  it("resumes from the scan checkpoint alone when nothing has ever been confirmed (restart before any confirmation)", async () => {
    const scanner = createChainLogScanner({ BACKEND_RPC_URL: rpcUrl } as NodeJS.ProcessEnv);
    const confirmationDepth = 1_000_000n; // deliberately never crossed — nothing gets CONFIRMED in this test.

    // --- "Run 1": fund task 1, index it, record the scan checkpoint. ---
    // `fromBlock: blockAfterTask1` (not `0n`) — the shared Hardhat chain's
    // real block history still carries the PRECEDING test's own on-chain
    // TaskFunded events (only that test's DB rows were cleared by
    // `afterEach`, not the chain itself), so scanning from genesis here
    // would re-discover them too.
    const blockAfterTask1 = await fundTask();
    const firstPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: blockAfterTask1,
      toBlock: blockAfterTask1,
    });
    expect(firstPass.eventsIndexed).toBe(1);
    await upsertScanCheckpoint(pool, { chainId, lastScannedBlock: blockAfterTask1 });
    await confirmIndexedEvents({
      client: pool,
      chainId,
      latestBlock: blockAfterTask1,
      confirmationDepth,
    });

    // Confirms round 1's own gap scenario is actually reproduced here:
    // nothing has been confirmed yet.
    expect(await findLastConfirmedBlockNumber(pool, chainId)).toBeNull();
    const checkpointAfterRun1 = await findScanCheckpoint(pool, chainId);
    expect(checkpointAfterRun1).toBe(blockAfterTask1);

    // --- "Downtime": task 2 is funded while nothing is scanning. ---
    const blockAfterTask2 = await fundTask();

    // --- "Run 2" (simulated restart): `main.ts`'s own startup logic
    // would find `lastConfirmed === null` here and MUST still resume from
    // `findScanCheckpoint() + 1`, not fall back to the current tip. ---
    const resumedFrom = (checkpointAfterRun1 ?? 0n) + 1n;
    const secondPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: resumedFrom,
      toBlock: blockAfterTask2,
    });
    // Task 2's own event is found, and task 1's is correctly not
    // re-scanned — proving the checkpoint-only resume path neither loses
    // the downtime event nor re-processes what run 1 already indexed.
    expect(secondPass.eventsIndexed).toBe(1);

    const rows = await findChainIndexedEventsByType(pool, { chainId, eventType: "TaskFunded" });
    expect(rows).toHaveLength(2);
    const uniqueTxHashes = new Set(rows.map((row) => row.txHash));
    expect(uniqueTxHashes.size).toBe(2);
  }, 30_000);
});
