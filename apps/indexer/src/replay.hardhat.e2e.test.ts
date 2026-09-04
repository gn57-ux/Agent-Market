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
import { indexBlockRange, replayEvents } from "./indexer.js";
import { findChainIndexedEventsByType } from "./repository.js";

/**
 * F-1811 / AC-1807 (T-1808): "真实执行一次事件重放（指定历史区块范围），
 * 重放结果与首次索引结果一致（可重复性）". A real Hardhat chain, real
 * on-chain events, and a genuine two-pass proof: index a real historical
 * range once via `indexBlockRange` (simulating the indexer's own normal
 * first pass), then replay that EXACT SAME range via `replayEvents`
 * (simulating an operator manually re-running it after a bug fix) — the
 * final stored state must be identical, not merely "still 2 rows" but the
 * SAME rows (same ids, same content), proving replay is a true no-op over
 * already-correct data rather than a lucky duplicate-count coincidence.
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

runIfOptedIn("apps/indexer: replayEvents real repeatability (T-1808, AC-1807)", () => {
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
    await pool?.end();
  });

  // Two `it` blocks below share the SAME Hardhat chain/DB — without this,
  // a second test's rows would accumulate on top of the first's.
  afterEach(async () => {
    await pool.query("DELETE FROM chain_indexed_events");
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
    return createTaskReceipt.blockNumber;
  }

  it("replaying an already-indexed historical range converges to the same real content (same blocks/txs/decoded data) — no drift, no missing/duplicate events", async () => {
    const scanner = createChainLogScanner({ BACKEND_RPC_URL: rpcUrl } as NodeJS.ProcessEnv);

    const blockAfterTask1 = await fundTask();
    const blockAfterTask2 = await fundTask();

    // "First pass" — the indexer's own normal, real-time indexing.
    const firstPass = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: blockAfterTask1,
      toBlock: blockAfterTask2,
    });
    expect(firstPass.eventsIndexed).toBe(2);

    const rowsAfterFirstPass = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(rowsAfterFirstPass).toHaveLength(2);

    // AC-1807: an operator manually replays the SAME historical range
    // (e.g. after fixing a decoding bug) via `replayEvents` — the exact
    // function `scripts/replay.ts` calls. Round 2's own N4 real P1+P2
    // fix: `replayEvents` upserts each row IN PLACE (`ON CONFLICT DO
    // UPDATE`, `upsertChainIndexedEvent`'s own doc comment), so a row's
    // `id` and `confirmation_status` do NOT change across a replay of
    // already-correct data — only `event_type`/`decoded_payload` are ever
    // written, and here they're already correct, so this really is a
    // true no-op, provable via full row equality (not just a
    // content-only comparison, which round 1's now-abandoned
    // delete-then-reinsert design would have needed instead).
    const replayResult = await replayEvents({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: blockAfterTask1,
      toBlock: blockAfterTask2,
    });
    expect(replayResult.logsScanned).toBe(firstPass.logsScanned);
    // Every log was successfully processed (an update-in-place counts
    // just as much as a fresh insert for `writeMode: "upsert"` — see
    // `indexBlockRange`'s own doc comment for why replay's own count
    // means "events covered", not "genuinely new rows").
    expect(replayResult.eventsIndexed).toBe(2);

    const rowsAfterReplay = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    const sortByBlock = (rows: typeof rowsAfterReplay) =>
      [...rows].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
    expect(sortByBlock(rowsAfterReplay)).toEqual(sortByBlock(rowsAfterFirstPass));
  }, 30_000);

  it("T-1808 round 1 (N4 real P1 fix): replay CORRECTS a genuinely wrong existing row, not just fills in missing ones — the specific gap plain re-scanning (ON CONFLICT DO NOTHING) could never close", async () => {
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

    const [correctRow] = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    if (!correctRow) throw new Error("expected exactly one row after the first pass");

    // Simulate a real decode bug's after-effects: the stored row for this
    // exact (chain_id, tx_hash, log_index) has WRONG decoded content —
    // this is the class of corruption plain re-scanning can never fix,
    // since `ON CONFLICT DO NOTHING` silently skips a row that already
    // exists there regardless of whether its content is correct.
    await pool.query(`UPDATE chain_indexed_events SET decoded_payload = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ budget: "1", corrupted: true }),
      correctRow.id,
    ]);
    const [corruptedRow] = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(corruptedRow?.decodedPayload).toEqual({ budget: "1", corrupted: true });

    // A plain re-scan (what `runPollTick` does every tick) must NOT fix
    // this — proving the gap replay's own delete-first semantics exist
    // to close.
    const plainRescan = await indexBlockRange({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: blockAfterTask1,
      toBlock: blockAfterTask1,
    });
    expect(plainRescan.eventsIndexed).toBe(0);
    const [stillCorruptedRow] = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(stillCorruptedRow?.decodedPayload).toEqual({ budget: "1", corrupted: true });

    // T-1808 round 2 (N4 real P2 fix): a real `CONFIRMED` row must stay
    // `CONFIRMED` across a replay — round 1's original delete-then-rescan
    // design silently demoted every replayed row back to the table's
    // default `PENDING_CONFIRMATION`, even already-final history.
    await pool.query(
      `UPDATE chain_indexed_events SET confirmation_status = 'CONFIRMED' WHERE id = $1`,
      [correctRow.id],
    );

    // Replay — the real fix — corrects it back to the genuine on-chain
    // data, via `ON CONFLICT DO UPDATE` (round 2, N4 real P1 fix: never
    // deletes the row first, so it is never even briefly missing).
    const replayResult = await replayEvents({
      scanner,
      client: pool,
      chainId,
      contractAddress: escrowAddress,
      fromBlock: blockAfterTask1,
      toBlock: blockAfterTask1,
    });
    expect(replayResult.eventsIndexed).toBe(1);

    const [correctedRow] = await findChainIndexedEventsByType(pool, {
      chainId,
      eventType: "TaskFunded",
    });
    expect(correctedRow?.decodedPayload).toEqual(correctRow.decodedPayload);
    expect(correctedRow?.decodedPayload).not.toEqual({ budget: "1", corrupted: true });
    // Same row, corrected in place — not a delete-and-reinsert.
    expect(correctedRow?.id).toBe(correctRow.id);
    // The CONFIRMED status set above survived the replay untouched.
    expect(correctedRow?.confirmationStatus).toBe("CONFIRMED");
  }, 30_000);
});
