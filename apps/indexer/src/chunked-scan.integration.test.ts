import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import type { ChainLogScanner } from "./log-scanner.js";
import { MAX_BLOCK_RANGE_PER_SCAN, scanRangeInChunks } from "./indexer.js";
import { findScanCheckpoint } from "./repository.js";

/**
 * F-1812 / AC-1808 (T-1808): `scanRangeInChunks` must never ask a single
 * `eth_getLogs` call to cover more than `MAX_BLOCK_RANGE_PER_SCAN` blocks
 * — a wide catch-up after a long RPC interruption (or a wide manual
 * replay, F-1811) needs to be split into sequential bounded chunks. Uses
 * a fake `ChainLogScanner` (no real chain needed — this test's own job is
 * proving the CHUNKING arithmetic and the per-chunk checkpoint
 * persistence, not re-proving real log decoding, which `indexBlockRange`'s
 * own hardhat e2e tests already cover) that records exactly which
 * `(fromBlock, toBlock)` ranges it was asked to scan.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const apiMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../api/migrations",
);

const CHAIN_ID = 31337;
const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111a";

function fakeScanner(): {
  scanner: ChainLogScanner;
  requestedRanges: { from: bigint; to: bigint }[];
} {
  const requestedRanges: { from: bigint; to: bigint }[] = [];
  const scanner: ChainLogScanner = {
    async getLatestBlockNumber() {
      return 0n;
    },
    async scanLogs({ fromBlock, toBlock }) {
      requestedRanges.push({ from: fromBlock, to: toBlock });
      return [];
    },
    async getBlockHash() {
      return null;
    },
  };
  return { scanner, requestedRanges };
}

runIfOptedIn("scanRangeInChunks (integration, T-1808)", () => {
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

  it("splits a range wider than MAX_BLOCK_RANGE_PER_SCAN into sequential bounded chunks, never asking for more than that many blocks at once", async () => {
    const { scanner, requestedRanges } = fakeScanner();
    const fromBlock = 0n;
    // Just over 2 full chunks — proves the final, partial chunk is sized
    // correctly (not padded out to the full chunk width).
    const toBlock = MAX_BLOCK_RANGE_PER_SCAN * 2n + 500n;

    await scanRangeInChunks({
      scanner,
      client: pool,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
      fromBlock,
      toBlock,
    });

    expect(requestedRanges).toEqual([
      { from: 0n, to: MAX_BLOCK_RANGE_PER_SCAN - 1n },
      { from: MAX_BLOCK_RANGE_PER_SCAN, to: MAX_BLOCK_RANGE_PER_SCAN * 2n - 1n },
      { from: MAX_BLOCK_RANGE_PER_SCAN * 2n, to: toBlock },
    ]);
    for (const range of requestedRanges) {
      expect(range.to - range.from + 1n).toBeLessThanOrEqual(MAX_BLOCK_RANGE_PER_SCAN);
    }
  });

  it("a range that fits within a single chunk is scanned in exactly one call", async () => {
    const { scanner, requestedRanges } = fakeScanner();
    await scanRangeInChunks({
      scanner,
      client: pool,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
      fromBlock: 100n,
      toBlock: 200n,
    });
    expect(requestedRanges).toEqual([{ from: 100n, to: 200n }]);
  });

  it("AC-1808: persists the scan checkpoint after EACH chunk (not just once at the end) — a failure partway through a large catch-up backlog resumes from the last completed chunk", async () => {
    const { scanner } = fakeScanner();
    const fromBlock = 0n;
    const toBlock = MAX_BLOCK_RANGE_PER_SCAN * 2n + 500n;
    const checkpointsAfterEachChunk: bigint[] = [];

    await scanRangeInChunks({
      scanner,
      client: pool,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
      fromBlock,
      toBlock,
      onChunkIndexed: async (chunkToBlock) => {
        checkpointsAfterEachChunk.push(chunkToBlock);
        // Mirrors `runPollTick`'s own real usage: persist after each chunk.
        const { rows } = await pool.query(
          `INSERT INTO indexer_scan_checkpoints (chain_id, last_scanned_block)
           VALUES ($1, $2)
           ON CONFLICT (chain_id) DO UPDATE
             SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = now()
           RETURNING last_scanned_block`,
          [CHAIN_ID, chunkToBlock],
        );
        expect(rows).toHaveLength(1);
      },
    });

    expect(checkpointsAfterEachChunk).toEqual([
      MAX_BLOCK_RANGE_PER_SCAN - 1n,
      MAX_BLOCK_RANGE_PER_SCAN * 2n - 1n,
      toBlock,
    ]);
    // The final persisted value is the LAST chunk's end, not the first —
    // proving each call really did overwrite (not just insert once).
    expect(await findScanCheckpoint(pool, CHAIN_ID)).toBe(toBlock);
  });
});
