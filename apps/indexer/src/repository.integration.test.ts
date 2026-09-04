import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import {
  confirmEventsUpToBlock,
  deletePendingEventsFromBlock,
  findChainIndexedEventsByType,
  findLastConfirmedBlockNumber,
  findPendingBlockHashes,
  findScanCheckpoint,
  insertChainIndexedEvent,
  rollBackReorgAtomically,
  upsertChainIndexedEvent,
  upsertScanCheckpoint,
} from "./repository.js";

/**
 * Runs the same `apps/api` migrations against the shared test database —
 * `chain_indexed_events` (0028) lives in `apps/api/migrations` (the single
 * migration source of truth for this project's whole business DB — see
 * that migration's own header comment), not duplicated here. This suite
 * only ever reads/writes the one table it owns.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const apiMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../api/migrations",
);

runIfOptedIn("chain_indexed_events repository (integration, T-1805)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    // This suite only needs the tables it exercises, so it applies each
    // migration file's raw SQL directly rather than depending on
    // apps/api's own `runMigrations` (which this app cannot import as a
    // library — see db.ts's note on why apps/api isn't importable).
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

  it("inserts a decoded event and reads it back", async () => {
    const inserted = await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 100n,
      blockHash: "0x" + "aa".repeat(32),
      txHash: "0x" + "bb".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: { budget: 1_000_000_000_000_000_000n, taskId: "0x" + "cc".repeat(32) },
    });
    expect(inserted).toBe(true);

    const rows = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskFunded",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blockNumber).toBe(100n);
    expect(rows[0]?.confirmationStatus).toBe("PENDING_CONFIRMATION");
    expect((rows[0]?.decodedPayload as { budget: string }).budget).toBe("1000000000000000000");
  });

  it("is idempotent: re-inserting the same (chain_id, tx_hash, log_index) does nothing on the second call", async () => {
    const input = {
      chainId: 31337,
      blockNumber: 200n,
      blockHash: "0x" + "dd".repeat(32),
      txHash: "0x" + "ee".repeat(32),
      logIndex: 3,
      eventType: "TaskCancelled",
      decodedPayload: { taskId: "0x" + "ff".repeat(32) },
    };
    const firstInsert = await insertChainIndexedEvent(pool, input);
    const secondInsert = await insertChainIndexedEvent(pool, input);
    expect(firstInsert).toBe(true);
    expect(secondInsert).toBe(false);

    const rows = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskCancelled",
    });
    expect(rows).toHaveLength(1);
  });

  it("rejects an invalid confirmation_status via the migration's own CHECK constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO chain_indexed_events
           (chain_id, block_number, block_hash, tx_hash, log_index, event_type, decoded_payload, confirmation_status)
         VALUES (31337, 1, '0x00', '0x00', 0, 'TaskFunded', '{}'::jsonb, 'NOT_A_REAL_STATE')`,
      ),
    ).rejects.toThrow();
  });

  it("AC-1806: confirmEventsUpToBlock promotes only rows at or below the threshold, leaving newer PENDING rows untouched", async () => {
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 100n,
      blockHash: "0x" + "01".repeat(32),
      txHash: "0x" + "11".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 105n,
      blockHash: "0x" + "02".repeat(32),
      txHash: "0x" + "12".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });

    const promoted = await confirmEventsUpToBlock(pool, { chainId: 31337, upToBlockNumber: 100n });
    expect(promoted).toBe(1);

    const rows = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskFunded",
    });
    const at100 = rows.find((row) => row.blockNumber === 100n);
    const at105 = rows.find((row) => row.blockNumber === 105n);
    expect(at100?.confirmationStatus).toBe("CONFIRMED");
    expect(at105?.confirmationStatus).toBe("PENDING_CONFIRMATION");
  });

  it("AC-1806: confirmEventsUpToBlock is idempotent — re-running with the same threshold promotes nothing new", async () => {
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 50n,
      blockHash: "0x" + "03".repeat(32),
      txHash: "0x" + "13".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    const first = await confirmEventsUpToBlock(pool, { chainId: 31337, upToBlockNumber: 50n });
    const second = await confirmEventsUpToBlock(pool, { chainId: 31337, upToBlockNumber: 50n });
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("AC-1806: findLastConfirmedBlockNumber returns null when nothing is confirmed yet, and the highest CONFIRMED block number once some rows are promoted", async () => {
    expect(await findLastConfirmedBlockNumber(pool, 31337)).toBeNull();

    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 10n,
      blockHash: "0x" + "04".repeat(32),
      txHash: "0x" + "14".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 20n,
      blockHash: "0x" + "05".repeat(32),
      txHash: "0x" + "15".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    // Only block 10 gets confirmed — block 20 stays pending.
    await confirmEventsUpToBlock(pool, { chainId: 31337, upToBlockNumber: 10n });

    expect(await findLastConfirmedBlockNumber(pool, 31337)).toBe(10n);
  });

  it("AC-1806 (round 2, N4 real P1 fix): findScanCheckpoint returns null until upsertScanCheckpoint has run, then the latest scanned height", async () => {
    expect(await findScanCheckpoint(pool, 31337)).toBeNull();

    await upsertScanCheckpoint(pool, { chainId: 31337, lastScannedBlock: 42n });
    expect(await findScanCheckpoint(pool, 31337)).toBe(42n);

    // A later poll tick overwrites the same chain's checkpoint rather
    // than accumulating rows — one real "how far have we scanned" value
    // per chain, not a history.
    await upsertScanCheckpoint(pool, { chainId: 31337, lastScannedBlock: 99n });
    expect(await findScanCheckpoint(pool, 31337)).toBe(99n);
  });

  it("AC-1806 (round 2, N4 real P1 fix): upsertScanCheckpoint persists a checkpoint even when the scanned range produced zero events", async () => {
    // No insertChainIndexedEvent call at all — proving the checkpoint is
    // NOT derived from chain_indexed_events rows (which is exactly the
    // gap Codex's real P1 finding caught: an empty-but-scanned range
    // leaves no row there for a resume point to be inferred from).
    await upsertScanCheckpoint(pool, { chainId: 31337, lastScannedBlock: 500n });
    expect(await findScanCheckpoint(pool, 31337)).toBe(500n);
    expect(
      await findChainIndexedEventsByType(pool, { chainId: 31337, eventType: "TaskFunded" }),
    ).toHaveLength(0);
  });

  it("AC-1805: findPendingBlockHashes returns only PENDING_CONFIRMATION blocks, ascending, one row per distinct height", async () => {
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 200n,
      blockHash: "0x" + "20".repeat(32),
      txHash: "0x" + "21".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    // A second event in the SAME block — must not produce a duplicate row.
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 200n,
      blockHash: "0x" + "20".repeat(32),
      txHash: "0x" + "22".repeat(32),
      logIndex: 1,
      eventType: "TaskCancelled",
      decodedPayload: {},
    });
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 100n,
      blockHash: "0x" + "10".repeat(32),
      txHash: "0x" + "11".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    // A CONFIRMED row — must never appear (design.md decision 3: the
    // confirmation depth is this Feature's own reorg-safety boundary).
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 50n,
      blockHash: "0x" + "05".repeat(32),
      txHash: "0x" + "05".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    await confirmEventsUpToBlock(pool, { chainId: 31337, upToBlockNumber: 50n });

    const pending = await findPendingBlockHashes(pool, 31337);
    expect(pending).toEqual([
      { blockNumber: 100n, blockHash: "0x" + "10".repeat(32) },
      { blockNumber: 200n, blockHash: "0x" + "20".repeat(32) },
    ]);
  });

  it("AC-1805: deletePendingEventsFromBlock removes only PENDING_CONFIRMATION rows at/after the given height, never CONFIRMED ones or earlier PENDING ones", async () => {
    // Confirmed FIRST, before the still-pending rows below exist, so
    // confirmEventsUpToBlock's own "promote everything <= threshold"
    // sweep only ever touches this one row.
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 50n,
      blockHash: "0x" + "05".repeat(32),
      txHash: "0x" + "05".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    await confirmEventsUpToBlock(pool, { chainId: 31337, upToBlockNumber: 50n });

    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 100n,
      blockHash: "0x" + "10".repeat(32),
      txHash: "0x" + "11".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 200n,
      blockHash: "0x" + "20".repeat(32),
      txHash: "0x" + "21".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 300n,
      blockHash: "0x" + "30".repeat(32),
      txHash: "0x" + "31".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });

    const deletedCount = await deletePendingEventsFromBlock(pool, {
      chainId: 31337,
      fromBlockNumber: 200n,
    });
    expect(deletedCount).toBe(2);

    const rows = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskFunded",
    });
    const blockNumbers = rows.map((row) => row.blockNumber).sort((a, b) => (a < b ? -1 : 1));
    // Block 50 (CONFIRMED, below threshold) and block 100 (PENDING, below
    // threshold) both survive; blocks 200 and 300 (PENDING, at/after the
    // threshold) are both gone.
    expect(blockNumbers).toEqual([50n, 100n]);
  });

  it("T-1807 round 1 (N4 real P1 fix): rollBackReorgAtomically deletes the pending rows AND rolls back the scan checkpoint together", async () => {
    await upsertScanCheckpoint(pool, { chainId: 31337, lastScannedBlock: 500n });
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 200n,
      blockHash: "0x" + "20".repeat(32),
      txHash: "0x" + "21".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });
    await insertChainIndexedEvent(pool, {
      chainId: 31337,
      blockNumber: 300n,
      blockHash: "0x" + "30".repeat(32),
      txHash: "0x" + "31".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: {},
    });

    const deletedCount = await rollBackReorgAtomically(pool, {
      chainId: 31337,
      fromBlockNumber: 200n,
    });
    expect(deletedCount).toBe(2);

    const rows = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskFunded",
    });
    expect(rows).toHaveLength(0);

    // The checkpoint rolled back to fromBlockNumber - 1 in the SAME
    // transaction — a restart right after this call resumes from
    // exactly block 200, re-scanning the rolled-back range, never from
    // the stale pre-rollback height (500).
    expect(await findScanCheckpoint(pool, 31337)).toBe(199n);
  });

  it("T-1807 round 1 (N4 real P1 fix): rollBackReorgAtomically rolls back nothing (delete or checkpoint) when the DELETE finds no matching rows — the checkpoint update itself is still applied, since a reorg check that found a hash mismatch is real regardless of whether any row happened to exist at that exact height", async () => {
    await upsertScanCheckpoint(pool, { chainId: 31337, lastScannedBlock: 500n });

    const deletedCount = await rollBackReorgAtomically(pool, {
      chainId: 31337,
      fromBlockNumber: 200n,
    });
    expect(deletedCount).toBe(0);
    expect(await findScanCheckpoint(pool, 31337)).toBe(199n);
  });

  it("T-1808 round 2 (N4 real P1+P2 fix): upsertChainIndexedEvent inserts a genuinely new row (returns true), then corrects it in place on a second call (returns false) without ever deleting it or disturbing its confirmation_status", async () => {
    const input = {
      chainId: 31337,
      blockNumber: 400n,
      blockHash: "0x" + "40".repeat(32),
      txHash: "0x" + "41".repeat(32),
      logIndex: 0,
      eventType: "TaskFunded",
      decodedPayload: { budget: "1000" },
    };
    const wasInserted = await upsertChainIndexedEvent(pool, input);
    expect(wasInserted).toBe(true);

    const [insertedRow] = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskFunded",
    });
    if (!insertedRow) throw new Error("expected exactly one row after the first upsert");
    expect(insertedRow.confirmationStatus).toBe("PENDING_CONFIRMATION");

    // A real operator marks it CONFIRMED (simulating what the normal
    // confirmation-depth flow would eventually do).
    await pool.query(
      `UPDATE chain_indexed_events SET confirmation_status = 'CONFIRMED' WHERE id = $1`,
      [insertedRow.id],
    );

    // Same (chain_id, tx_hash, log_index), corrected content — a real
    // decode-bug fix's own re-run.
    const wasInsertedAgain = await upsertChainIndexedEvent(pool, {
      ...input,
      decodedPayload: { budget: "2000", corrected: true },
    });
    expect(wasInsertedAgain).toBe(false); // an UPDATE, not a fresh INSERT

    const [correctedRow] = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskFunded",
    });
    if (!correctedRow) throw new Error("expected exactly one row after the second upsert");
    // Same row (never deleted): same id.
    expect(correctedRow.id).toBe(insertedRow.id);
    // Content corrected.
    expect(correctedRow.decodedPayload).toEqual({ budget: "2000", corrected: true });
    // Confirmation status untouched by the upsert.
    expect(correctedRow.confirmationStatus).toBe("CONFIRMED");

    // Never more than one row for this identity, across either call.
    const allRows = await findChainIndexedEventsByType(pool, {
      chainId: 31337,
      eventType: "TaskFunded",
    });
    expect(allRows).toHaveLength(1);
  });
});
