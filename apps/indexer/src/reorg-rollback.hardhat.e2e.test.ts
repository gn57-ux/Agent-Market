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
import { detectAndRollBackReorg, indexBlockRange } from "./indexer.js";
import { findChainIndexedEventsByType } from "./repository.js";

/**
 * AC-1805's real full-flow proof: a GENUINE Hardhat network reorg (not a
 * fake scanner swap) — `evm_snapshot`/`evm_revert` are Hardhat's own
 * standard JSON-RPC primitives for this exact purpose (industry-standard
 * technique for testing reorg handling against a real EVM node): take a
 * snapshot, mine a transaction, revert to the snapshot (discarding that
 * block for real), then mine a DIFFERENT transaction — the chain's own
 * canonical block at that height now has a genuinely different hash, the
 * same observable shape a real network reorg produces. This directly
 * follows requirements.md's own risk note ("若测试环境不支持可靠重组模拟，
 * 需要提前向用户报告技术限制，不得用构造的假数据伪装验证了重组") — this
 * technique is real and reliable, not a workaround, so no such report is
 * needed.
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

runIfOptedIn("apps/indexer: real Hardhat network reorg detection + rollback (T-1807)", () => {
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

    // rollBackReorgAtomically (T-1807) writes to indexer_scan_checkpoints
    // in the same transaction as its own DELETE.
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

  // Two `it` blocks below share the SAME Hardhat chain/DB — without this,
  // a second test's rows would accumulate on top of the first's.
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
    // Same fix breakpoint-resume.hardhat.e2e.test.ts's own test first
    // caught: use the receipt's own blockNumber, never a separate
    // getBlockNumber() call (viem's default caching makes a second call
    // shortly after new blocks were mined silently return a stale height).
    return createTaskReceipt.blockNumber;
  }

  it("detects a real Hardhat network reorg, rolls back the affected PENDING_CONFIRMATION event, and re-indexes the real post-reorg event with nothing lost or duplicated", async () => {
    const scanner = createChainLogScanner({ BACKEND_RPC_URL: rpcUrl } as NodeJS.ProcessEnv);

    // --- Task 1: funded and indexed BEFORE the snapshot — this event
    // must survive the reorg untouched (it's on the canonical chain both
    // before and after). ---
    const blockAfterTask1 = await fundTask();
    const firstPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: 0n,
      toBlock: blockAfterTask1,
    });
    expect(firstPass.eventsIndexed).toBe(1);

    // A reorg check right now must find nothing wrong — every stored
    // PENDING block's hash still matches the (unchanged) canonical chain.
    expect(await detectAndRollBackReorg({ scanner, pool, chainId })).toBeNull();

    // --- Real Hardhat snapshot, right before task 2 is mined. ---
    const snapshotId = (await publicClient.request({
      method: "evm_snapshot" as never,
      params: [] as never,
    })) as string;

    // --- Task 2: mined, indexed, PENDING — this is the event a real
    // reorg is about to erase from the canonical chain. ---
    const blockAfterTask2 = await fundTask();
    const secondPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: blockAfterTask1 + 1n,
      toBlock: blockAfterTask2,
    });
    expect(secondPass.eventsIndexed).toBe(1);
    const rowsBeforeReorg = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(rowsBeforeReorg).toHaveLength(2);

    // --- The real reorg: revert to the snapshot (task 2's block is
    // genuinely gone from the chain), then mine a DIFFERENT transaction
    // (task 3, a different on-chain taskId) — the chain's real canonical
    // block at task 2's old height now has a different hash. ---
    const reverted = (await publicClient.request({
      method: "evm_revert" as never,
      params: [snapshotId] as never,
    })) as boolean;
    expect(reverted).toBe(true);

    const blockAfterTask3 = await fundTask();
    // Hardhat's sequential auto-mining means the replacement block lands
    // at the exact same height task 2's block occupied — the real,
    // observable shape of a same-height reorg.
    expect(blockAfterTask3).toBe(blockAfterTask2);

    // --- The reorg check must now catch it: task 2's stored block_hash
    // no longer matches the chain's real current hash at that height. ---
    const reorg = await detectAndRollBackReorg({ scanner, pool, chainId });
    expect(reorg).not.toBeNull();
    expect(reorg?.reorgDetectedAtBlock).toBe(blockAfterTask2);
    expect(reorg?.eventsRolledBack).toBe(1);

    // Task 2's row is gone; task 1's is untouched.
    const rowsAfterRollback = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(rowsAfterRollback).toHaveLength(1);
    expect(rowsAfterRollback[0]?.blockNumber).toBe(blockAfterTask1);

    // --- Re-scan from the rollback point, exactly as main.ts's own poll
    // loop would after a detected reorg. ---
    const rescanPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: reorg?.reorgDetectedAtBlock ?? 0n,
      toBlock: blockAfterTask3,
    });
    expect(rescanPass.eventsIndexed).toBe(1);

    // Final state: task 1's original event + task 3's real replacement
    // event — task 2's reorged-away event never reappears.
    const finalRows = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(finalRows).toHaveLength(2);
    const bigintAscending = (a: bigint, b: bigint) => (a < b ? -1 : 1);
    const finalBlockNumbers = finalRows.map((row) => row.blockNumber).sort(bigintAscending);
    expect(finalBlockNumbers).toEqual([blockAfterTask1, blockAfterTask3].sort(bigintAscending));

    // A further reorg check now finds nothing wrong — the stored state
    // matches the real (post-reorg) canonical chain.
    expect(await detectAndRollBackReorg({ scanner, pool, chainId })).toBeNull();
  }, 30_000);

  /**
   * T-1807 round 1 (N4 real P1 fix): `detectAndRollBackReorg` alone can
   * only compare a stored `PENDING_CONFIRMATION` row's hash against the
   * chain's current one — it has NOTHING to compare when a block produced
   * zero matching events (no row, no stored hash ever existed for that
   * height). This test reproduces exactly that gap: a real Hardhat
   * `evm_mine`-forced EMPTY block gets reorged away and replaced by one
   * that DOES contain a real event. `detectAndRollBackReorg` alone must
   * find nothing wrong (proving the gap is real); `main.ts`'s own fix —
   * always re-scanning the trailing `confirmationDepth` window every tick,
   * not just genuinely-new blocks — is what actually catches the new
   * event, simulated here by directly computing the same bounded
   * `scanFromBlock` main.ts's own loop computes and re-scanning that
   * range even though `nextFromBlock` had already advanced past it.
   */
  it("a real reorg that replaces a previously-EMPTY block with one containing a real event is invisible to the hash check alone, but is caught by re-scanning the confirmation window", async () => {
    const scanner = createChainLogScanner({ BACKEND_RPC_URL: rpcUrl } as NodeJS.ProcessEnv);

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

    // A large standing allowance, approved BEFORE the snapshot below, so
    // the later single `createTask` call after the revert needs no
    // approve transaction of its own — an approve+createTask pair would
    // land the event-bearing tx ONE block AFTER the reorged height,
    // which would already be covered by the loop's own normal
    // `nextFromBlock` bookkeeping and defeat this test's own purpose
    // (proving the hash-check-alone gap at the EXACT reorged height).
    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const bigAllowance = 1_000_000_000_000_000_000_000n;
    const bigApproveHash = await requesterWallet.writeContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "approve",
      args: [escrowAddress, bigAllowance],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: bigApproveHash });

    const snapshotId = (await publicClient.request({
      method: "evm_snapshot" as never,
      params: [] as never,
    })) as string;

    // Force a real, genuinely EMPTY block (no transaction at all) — the
    // exact case `chain_indexed_events` has no row and no hash for.
    await publicClient.request({ method: "evm_mine" as never, params: [] as never });
    const emptyBlockNumber = await publicClient.getBlockNumber();
    const emptyBlockPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: emptyBlockNumber,
      toBlock: emptyBlockNumber,
    });
    expect(emptyBlockPass.eventsIndexed).toBe(0);
    // Nothing pending at that height — nothing for the hash check to
    // compare against.
    expect(
      await findChainIndexedEventsByType(pool, { chainId, eventType: "TaskFunded" }),
    ).toHaveLength(1);

    // Simulates main.ts's own checkpoint bookkeeping having already moved
    // past the empty block (exactly what a real poll tick would do).
    const nextFromBlockBeforeReorg = emptyBlockNumber + 1n;

    // The real reorg: revert to the snapshot (the empty block is
    // genuinely gone), then mine a REAL transaction at that SAME height.
    // A single `createTask` call (not the two-transaction `fundTask()`
    // helper — approve+createTask would land the event-bearing tx ONE
    // block AFTER the reorged height, which would already be covered by
    // `nextFromBlockBeforeReorg` alone and defeat this test's own
    // purpose) — the requester's allowance was set generously enough
    // during the initial deployment task above to cover this directly.
    const reverted = (await publicClient.request({
      method: "evm_revert" as never,
      params: [snapshotId] as never,
    })) as boolean;
    expect(reverted).toBe(true);
    taskCounter += 1;
    const taskIdOnChain = ("0x" + taskCounter.toString(16).padStart(64, "0")) as `0x${string}`;
    const budget = 1_000_000_000_000_000_000n;
    const block = await publicClient.getBlock();
    const deliveryDeadline = block.timestamp + DELIVERY_WINDOW_SECONDS;
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
    const blockAfterTask2 = createTaskReceipt.blockNumber;
    expect(blockAfterTask2).toBe(emptyBlockNumber);

    // The hash-comparison check alone finds nothing wrong — proving the
    // gap this test exists to demonstrate.
    expect(await detectAndRollBackReorg({ scanner, pool, chainId })).toBeNull();
    expect(
      await findChainIndexedEventsByType(pool, { chainId, eventType: "TaskFunded" }),
    ).toHaveLength(1);

    // main.ts's own fix: re-scan the trailing confirmationDepth window
    // every tick, even below `nextFromBlock`. With a depth of 5 (well
    // above this test's tiny block range), `scanFromBlock` covers the
    // reorged height even though the loop's own bookkeeping had already
    // moved past it.
    const confirmationDepth = 5n;
    const latest = await publicClient.getBlockNumber();
    const windowStart = latest - confirmationDepth + 1n;
    // Clamped to this test's own known-good starting point
    // (`blockAfterTask1`), not just `> 0n` — this shared Hardhat chain
    // still carries every PRECEDING test's own real on-chain blocks (only
    // this suite's own DB rows are cleared by `afterEach`, not the chain
    // itself), and main.ts's real production process never has that
    // artifact (one continuous chain, one continuous DB, no per-test
    // reset) — this clamp exists only to keep this test's own simulated
    // window from sweeping into another test's unrelated blocks.
    const boundedWindowStart = windowStart > blockAfterTask1 ? windowStart : blockAfterTask1;
    const scanFromBlock =
      nextFromBlockBeforeReorg < boundedWindowStart ? nextFromBlockBeforeReorg : boundedWindowStart;
    expect(scanFromBlock).toBeLessThanOrEqual(emptyBlockNumber);

    const windowRescan = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: scanFromBlock,
      toBlock: latest,
    });
    expect(windowRescan.eventsIndexed).toBe(1);

    const finalRows = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(finalRows).toHaveLength(2);
    const bigintAscending = (a: bigint, b: bigint) => (a < b ? -1 : 1);
    expect(finalRows.map((row) => row.blockNumber).sort(bigintAscending)).toEqual(
      [blockAfterTask1, blockAfterTask2].sort(bigintAscending),
    );
  }, 30_000);
});
