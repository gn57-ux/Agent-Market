import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from "viem";
import { requireTestDatabaseUrl, TASK_FUNDED_EVENT_ABI } from "@agent-market/domain";
import type { ChainLogScanner, ScannedLog } from "./log-scanner.js";
import { MAX_BLOCK_RANGE_PER_SCAN, PollTickError, runPollTick } from "./indexer.js";
import { findChainIndexedEventsByType, findScanCheckpoint } from "./repository.js";

/**
 * T-1807 round 2 (N4 real P1 fix): `main.ts`'s own poll loop wraps
 * `runPollTick` in try/catch so a single transient failure (RPC hiccup,
 * momentary database error) does not terminate the whole process — it
 * used to (an uncaught rejection propagated to `main().catch()`, which
 * calls `process.exit(1)`), silently contradicting this Feature's own
 * documented "surfaces and retries on the next interval" claim.
 *
 * `runPollTick` lives in `indexer.ts` specifically so it can be imported
 * here without triggering `main.ts`'s own unconditional `main()` call at
 * module load (see `indexer.ts`'s own doc comment on `runPollTick`).
 * `main.ts`'s own try/catch wrapper is 3 lines of trivial control flow
 * with nothing to unit-test on its own — what actually needs a real proof
 * is the CONTRACT it depends on: a tick that throws must not corrupt or
 * silently advance state, so retrying with the SAME `nextFromBlock` next
 * interval is genuinely safe and correct, not just "doesn't crash".
 *
 * T-1808 round 1 (N4 real P1 fix): `runPollTick` now throws a
 * `PollTickError` carrying `partialNextFromBlock` — real progress made
 * before the failure — instead of leaving the caller to always retry from
 * the pre-tick starting point. The single-chunk test below still proves
 * the ORIGINAL round-2 contract (no chunk ever completed, so partial
 * progress equals the pre-tick value); the multi-chunk test further down
 * proves the NEW contract this round's fix adds (some chunks DID complete
 * before a later one failed, and that real progress is not lost).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const apiMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../api/migrations",
);

const CHAIN_ID = 31337;
const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111a";
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID = keccak256(toHex("poll-tick-resilience-task"));

function buildRealTaskFundedLog(): ScannedLog {
  const topics = encodeEventTopics({
    abi: TASK_FUNDED_EVENT_ABI,
    eventName: "TaskFunded",
    args: { taskId: TASK_ID, requester: getAddress(REQUESTER_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "deliveryDeadline", type: "uint64" },
    ],
    [getAddress(TOKEN_ADDRESS), 1_000n, 1_893_456_000n],
  );
  return {
    address: CONTRACT_ADDRESS,
    topics,
    data,
    logIndex: 0,
    blockNumber: 100n,
    blockHash: "0x" + "aa".repeat(32),
    transactionHash: "0x" + "bb".repeat(32),
  };
}

function fakeScannerThatFailsOnce(realLog: ScannedLog): ChainLogScanner {
  let getLatestCalls = 0;
  return {
    async getLatestBlockNumber() {
      getLatestCalls += 1;
      if (getLatestCalls === 1) {
        throw new Error("simulated transient RPC failure");
      }
      return realLog.blockNumber;
    },
    async scanLogs() {
      return [realLog];
    },
    async getBlockHash() {
      return realLog.blockHash;
    },
  };
}

runIfOptedIn("runPollTick resilience (integration, T-1807 round 2)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    const fs = await import("node:fs/promises");
    const chainIndexedEventsSql = await fs.readFile(
      path.join(apiMigrationsDir, "0028_create_chain_indexed_events.sql"),
      "utf8",
    );
    const scanCheckpointsSql = await fs.readFile(
      path.join(apiMigrationsDir, "0030_create_indexer_scan_checkpoints.sql"),
      "utf8",
    );
    await pool.query(`DROP TABLE IF EXISTS chain_indexed_events`);
    await pool.query(chainIndexedEventsSql);
    await pool.query(`DROP TABLE IF EXISTS indexer_scan_checkpoints`);
    await pool.query(scanCheckpointsSql);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS chain_indexed_events`);
    await pool.query(`DROP TABLE IF EXISTS indexer_scan_checkpoints`);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM chain_indexed_events");
    await pool.query("DELETE FROM indexer_scan_checkpoints");
  });

  it("a tick that throws propagates the error (does not swallow it) and leaves nextFromBlock untouched, so retrying with the same value next interval correctly indexes the event that was there all along", async () => {
    const realLog = buildRealTaskFundedLog();
    const scanner = fakeScannerThatFailsOnce(realLog);
    const nextFromBlockBeforeFailure = 90n;

    // First tick: the scanner's own getLatestBlockNumber throws — the
    // function itself must NOT swallow this (main.ts's own catch is what
    // logs and continues, not runPollTick). Thrown as a `PollTickError`
    // whose own `cause` is the real underlying error, and whose
    // `partialNextFromBlock` equals the pre-tick value here (nothing had
    // completed yet when it failed).
    let caughtError: unknown;
    try {
      await runPollTick({
        scanner,
        pool,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_ADDRESS,
        confirmationDepth: 5n,
        nextFromBlock: nextFromBlockBeforeFailure,
      });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(PollTickError);
    expect((caughtError as PollTickError).cause).toBeInstanceOf(Error);
    expect(((caughtError as PollTickError).cause as Error).message).toBe(
      "simulated transient RPC failure",
    );
    expect((caughtError as PollTickError).partialNextFromBlock).toBe(nextFromBlockBeforeFailure);

    // Nothing was written — the failed tick had no partial side effects.
    expect(
      await findChainIndexedEventsByType(pool, { chainId: CHAIN_ID, eventType: "TaskFunded" }),
    ).toHaveLength(0);

    // Second tick, using the SAME nextFromBlock a real main.ts loop would
    // retry with (the failed tick never advanced it) — this time the
    // scanner succeeds, and the range genuinely still starts from before
    // the failure, so nothing produced during the "outage" is skipped.
    const { nextFromBlock: nextFromBlockAfterRecovery } = await runPollTick({
      scanner,
      pool,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
      confirmationDepth: 5n,
      nextFromBlock: nextFromBlockBeforeFailure,
    });

    expect(nextFromBlockAfterRecovery).toBe(realLog.blockNumber + 1n);
    const rows = await findChainIndexedEventsByType(pool, {
      chainId: CHAIN_ID,
      eventType: "TaskFunded",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blockNumber).toBe(realLog.blockNumber);
  });

  it("T-1808 round 1 (N4 real P1 fix): a failure on a LATER chunk of a wide catch-up scan reports partial progress through the last chunk that DID complete, instead of discarding it back to the pre-tick starting point", async () => {
    // A wide-enough range that it takes 3 chunks to cover: [0, MAX-1],
    // [MAX, 2MAX-1], [2MAX, latest]. The fake scanner lets chunk 1
    // succeed, then fails chunk 2.
    const latest = MAX_BLOCK_RANGE_PER_SCAN * 2n;
    let scanLogsCalls = 0;
    let hasFailedOnce = false;
    const scanner: ChainLogScanner = {
      async getLatestBlockNumber() {
        return latest;
      },
      async scanLogs() {
        scanLogsCalls += 1;
        if (scanLogsCalls === 2 && !hasFailedOnce) {
          hasFailedOnce = true;
          throw new Error("simulated failure on the second chunk");
        }
        return [];
      },
      async getBlockHash() {
        return null;
      },
    };

    let caughtError: unknown;
    try {
      await runPollTick({
        scanner,
        pool,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_ADDRESS,
        confirmationDepth: 1n,
        nextFromBlock: 0n,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(PollTickError);
    // Chunk 1 (ending at MAX_BLOCK_RANGE_PER_SCAN - 1) completed before
    // chunk 2 failed — real progress that must not be discarded back to
    // the pre-tick `nextFromBlock: 0n`.
    expect((caughtError as PollTickError).partialNextFromBlock).toBe(MAX_BLOCK_RANGE_PER_SCAN);
    expect(scanLogsCalls).toBe(2); // never reached chunk 3

    // The scan checkpoint reflects the same real progress — chunk 1's own
    // `onChunkIndexed` call persisted it before chunk 2 ever ran.
    expect(await findScanCheckpoint(pool, CHAIN_ID)).toBe(MAX_BLOCK_RANGE_PER_SCAN - 1n);

    // A retry using `partialNextFromBlock` (exactly what main.ts's own
    // catch block now does) resumes from chunk 2's own start — chunk 1 is
    // NOT re-scanned.
    const callsBeforeRetry = scanLogsCalls;
    const { nextFromBlock: nextFromBlockAfterRecovery } = await runPollTick({
      scanner,
      pool,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
      confirmationDepth: 1n,
      nextFromBlock: (caughtError as PollTickError).partialNextFromBlock,
    });
    // Chunk 2 ([MAX, 2MAX-1]) then chunk 3 ([2MAX, latest]) — exactly 2
    // MORE calls, not the 3 a from-scratch re-scan (chunk 1 again too)
    // would have made.
    expect(scanLogsCalls - callsBeforeRetry).toBe(2);
    expect(nextFromBlockAfterRecovery).toBe(latest + 1n);
    expect(await findScanCheckpoint(pool, CHAIN_ID)).toBe(latest);
  });
});
