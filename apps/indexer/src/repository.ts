import type { Pool } from "pg";
import type { Queryable } from "./db.js";

/**
 * F-1807 (T-1805): one decoded `TaskEscrow` event log, ready to persist.
 * `blockNumber`/`logIndex` are plain numbers (not `bigint`) — Postgres
 * `INTEGER`/`BIGINT` columns round-trip through `pg` as JS numbers/strings
 * depending on size; `logIndex` fits comfortably in `INTEGER` (a block's
 * log count never approaches 2^31), and `blockNumber` is passed as a
 * `bigint` to `pg`, which serializes it correctly for the `BIGINT` column
 * without precision loss (unlike a plain JS `number`, which loses
 * precision above 2^53).
 */
export interface ChainIndexedEventInput {
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  eventType: string;
  decodedPayload: unknown;
}

/**
 * Writes one decoded event log into `chain_indexed_events`. Idempotent via
 * `ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING` — the migration's
 * own `UNIQUE` constraint on that triple is the natural, chain-native
 * identity of a log, so re-scanning an already-indexed block range (T-1806's
 * breakpoint resume, or a re-run after an operator mistake) never produces
 * duplicate rows and never needs this function's caller to first check
 * "have I already indexed this log". Returns whether a new row was actually
 * inserted (`false` on a genuine duplicate), so a caller doing bulk counting
 * (a scan pass's own summary, or this Task's own e2e assertions) can tell
 * "already indexed" apart from "just indexed" without a second query.
 */
export async function insertChainIndexedEvent(
  client: Queryable,
  input: ChainIndexedEventInput,
): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO chain_indexed_events
       (chain_id, block_number, block_hash, tx_hash, log_index, event_type, decoded_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [
      input.chainId,
      input.blockNumber,
      input.blockHash,
      input.txHash,
      input.logIndex,
      input.eventType,
      // Every `Decoded*Event` payload (packages/domain/src/chain-events/*.ts)
      // carries `bigint` fields (budget/stake/deadlines) — plain
      // `JSON.stringify` throws "Do not know how to serialize a BigInt" on
      // those. Same replacer this repo's own hardhat e2e tests already use
      // (full-lifecycle.hardhat.e2e.test.ts, phase2-integration.hardhat.e2e.test.ts)
      // for the identical problem.
      JSON.stringify(input.decodedPayload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ],
  );
  return rows.length > 0;
}

/**
 * F-1811 / AC-1807 (T-1808 round 2, N4 real P1+P2 fix): `replayEvents`'s
 * own write primitive — corrects a row already at this `(chain_id,
 * tx_hash, log_index)` identity by overwriting only `event_type` and
 * `decoded_payload` (a real decode bug fix's own output), via `ON
 * CONFLICT ... DO UPDATE` rather than `insertChainIndexedEvent`'s `DO
 * NOTHING`. Deliberately does NOT touch `confirmation_status` or
 * `indexed_at` — round 1's original "delete the whole range, then
 * re-insert fresh" design regressed already-`CONFIRMED` historical events
 * back to `PENDING_CONFIRMATION` (a real N4 P2 finding) purely as a side
 * effect of the delete; upsert-in-place never disturbs a row's existing
 * confirmation state at all, so that regression cannot happen by
 * construction, not by a follow-up fix layered on top. Also, critically,
 * never creates a window where the row does not exist at all (round 1's
 * OWN real P1 finding: delete-then-rescan committed the delete before the
 * slow, multi-chunk, real-network re-scan even started, so any failure —
 * RPC error, DB error, process crash — partway through could leave a
 * historical range permanently empty, since ordinary polling never
 * revisits blocks outside its own trailing confirmation window) — each
 * row transitions from its old content to its new content in ONE atomic
 * statement, so a replay that fails partway through a wide range leaves
 * every not-yet-reached row exactly as it was (possibly still wrong, but
 * never GONE), and every already-reached row already corrected.
 */
export async function upsertChainIndexedEvent(
  client: Queryable,
  input: ChainIndexedEventInput,
): Promise<boolean> {
  const { rows } = await client.query<{ inserted: boolean }>(
    `INSERT INTO chain_indexed_events
       (chain_id, block_number, block_hash, tx_hash, log_index, event_type, decoded_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE
       SET event_type = EXCLUDED.event_type,
           decoded_payload = EXCLUDED.decoded_payload
     RETURNING (xmax = 0) AS inserted`,
    [
      input.chainId,
      input.blockNumber,
      input.blockHash,
      input.txHash,
      input.logIndex,
      input.eventType,
      JSON.stringify(input.decodedPayload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ],
  );
  // `xmax = 0` is Postgres's own real signal for "this row was freshly
  // inserted by this statement, not updated" — the standard, documented
  // idiom for telling an `ON CONFLICT DO UPDATE`'s two outcomes apart
  // without a second round trip.
  return rows[0]?.inserted ?? false;
}

export interface ChainIndexedEventRow {
  id: string;
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  eventType: string;
  decodedPayload: unknown;
  confirmationStatus: "PENDING_CONFIRMATION" | "CONFIRMED";
  indexedAt: Date;
}

/**
 * Read-only helper for this Task's own e2e assertions (and any future
 * caller that needs "what did the indexer record for this event type").
 * `pg` returns `BIGINT` columns as strings by default (unlike `TIMESTAMPTZ`,
 * which it maps to `Date` — see `outbox/repository.ts`'s own note on that),
 * so both `chain_id` and `block_number` are parsed explicitly here rather
 * than left as raw driver strings, matching this function's own declared
 * return type. `chain_id` became `BIGINT` in the migration itself (N4
 * review, real P2 — see that migration's own header comment) specifically
 * because a real, valid configured chain id can exceed PostgreSQL
 * `INTEGER`'s 32-bit range while still fitting comfortably in a JS
 * `number` (well under `Number.MAX_SAFE_INTEGER`, the same bound
 * `chain-config.ts`'s own `CHAIN_ID` validation already enforces) — parsed
 * back to `number` here, not `bigint`, to match every other `chainId:
 * number` signature in this package (`log-scanner.ts`, `indexer.ts`,
 * `decode-any-event.ts`'s callers).
 */
export async function findChainIndexedEventsByType(
  client: Queryable,
  params: { chainId: number; eventType: string },
): Promise<ChainIndexedEventRow[]> {
  const { rows } = await client.query<{
    id: string;
    chain_id: string;
    block_number: string;
    block_hash: string;
    tx_hash: string;
    log_index: number;
    event_type: string;
    decoded_payload: unknown;
    confirmation_status: "PENDING_CONFIRMATION" | "CONFIRMED";
    indexed_at: Date;
  }>(
    `SELECT id, chain_id, block_number, block_hash, tx_hash, log_index, event_type,
            decoded_payload, confirmation_status, indexed_at
       FROM chain_indexed_events
      WHERE chain_id = $1 AND event_type = $2
      ORDER BY block_number, log_index`,
    [params.chainId, params.eventType],
  );
  return rows.map((row) => ({
    id: row.id,
    chainId: Number(row.chain_id),
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    eventType: row.event_type,
    decodedPayload: row.decoded_payload,
    confirmationStatus: row.confirmation_status,
    indexedAt: row.indexed_at,
  }));
}

/**
 * F-1809 / AC-1806 (T-1806): promotes every still-`PENDING_CONFIRMATION`
 * row at or below `upToBlockNumber` to `CONFIRMED` — the caller (the main
 * scan loop) computes `upToBlockNumber` as `latestChainBlock -
 * confirmationDepth`, so a row only gets promoted once it has genuinely
 * accumulated that many confirmations. Deliberately a plain `UPDATE`, not
 * a "confirm one row at a time" loop — confirmation is a pure bookkeeping
 * state transition with no per-row side effect to sequence, so there is no
 * reason to pay N round trips for N rows crossing the threshold in the
 * same scan tick.
 */
export async function confirmEventsUpToBlock(
  client: Queryable,
  params: { chainId: number; upToBlockNumber: bigint },
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE chain_indexed_events
        SET confirmation_status = 'CONFIRMED'
      WHERE chain_id = $1
        AND confirmation_status = 'PENDING_CONFIRMATION'
        AND block_number <= $2`,
    [params.chainId, params.upToBlockNumber],
  );
  return rowCount ?? 0;
}

/**
 * F-1810 / AC-1806 (T-1806): "重启后从上次确认高度继续" — the indexer's own
 * breakpoint. Reads the highest `block_number` this chain has any
 * `CONFIRMED` row for; `null` means nothing has ever been confirmed yet
 * (a genuinely fresh chain/index, or every row so far is still within the
 * confirmation window), in which case the caller falls back to its own
 * configured/current-tip starting point — this function deliberately does
 * NOT decide that fallback itself (CLAUDE.md 原则 7's own complementary
 * principle: a read-only query reports what it found, the caller — which
 * knows about `INDEXER_START_BLOCK`/"start from the current tip" — decides
 * what "nothing confirmed yet" means for it).
 *
 * Only `CONFIRMED` rows count, deliberately not `MAX(block_number)` across
 * both states — a `PENDING_CONFIRMATION` row near the tip is, by
 * definition, still within the reorg-risk window (T-1807's own concern);
 * resuming from ONE PAST a merely-pending block would skip re-scanning it,
 * and a genuine reorg affecting that unconfirmed block would then never
 * be detected on restart. Resuming from the last CONFIRMED height instead
 * means every PENDING_CONFIRMATION row gets re-scanned on restart — safe
 * and correct, since `insertChainIndexedEvent`'s own `ON CONFLICT DO
 * NOTHING` makes re-inserting an already-indexed log a genuine no-op.
 */
export async function findLastConfirmedBlockNumber(
  client: Queryable,
  chainId: number,
): Promise<bigint | null> {
  const { rows } = await client.query<{ max: string | null }>(
    `SELECT MAX(block_number) FROM chain_indexed_events
      WHERE chain_id = $1 AND confirmation_status = 'CONFIRMED'`,
    [chainId],
  );
  const max = rows[0]?.max;
  return max === null || max === undefined ? null : BigInt(max);
}

/**
 * T-1806 round 2 (N4 real P1 fix): records the highest block a scan pass
 * actually covered for this chain, independent of confirmation state.
 * Called every poll tick a scan ran (`main.ts`), even one that found zero
 * matching events — `chain_indexed_events` alone has no row to answer
 * "was this empty range already scanned", which is exactly the gap that
 * let a restart-before-any-confirmation jump straight to the tip and
 * silently skip already-scanned and downtime blocks. `ON CONFLICT`
 * upsert: one checkpoint row per chain, always overwritten with the
 * latest scanned height.
 */
export async function upsertScanCheckpoint(
  client: Queryable,
  params: { chainId: number; lastScannedBlock: bigint },
): Promise<void> {
  await client.query(
    `INSERT INTO indexer_scan_checkpoints (chain_id, last_scanned_block)
     VALUES ($1, $2)
     ON CONFLICT (chain_id) DO UPDATE
       SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = now()`,
    [params.chainId, params.lastScannedBlock],
  );
}

/**
 * Read-side counterpart to `upsertScanCheckpoint` — `null` means this
 * chain has never completed a scan tick yet (a genuinely fresh index),
 * in which case the caller falls back to its own configured/current-tip
 * starting point, same as `findLastConfirmedBlockNumber`'s own `null`
 * case.
 */
export async function findScanCheckpoint(
  client: Queryable,
  chainId: number,
): Promise<bigint | null> {
  const { rows } = await client.query<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM indexer_scan_checkpoints WHERE chain_id = $1`,
    [chainId],
  );
  const value = rows[0]?.last_scanned_block;
  return value === undefined ? null : BigInt(value);
}

export interface PendingBlockHash {
  blockNumber: bigint;
  blockHash: string;
}

/**
 * F-1808 / AC-1805 (T-1807): the reorg-detection candidate set — every
 * DISTINCT `(block_number, block_hash)` pair still `PENDING_CONFIRMATION`
 * for this chain, ordered ascending. Deliberately scoped to PENDING rows
 * only, never `CONFIRMED` ones — design.md decision 3's own reasoning: a
 * `CONFIRMED` row has, by definition, survived `confirmationDepth` real
 * confirmations, which is exactly what makes a reorg reaching it treated
 * as not worth defending against at this layer (the whole point of a
 * confirmation depth). `DISTINCT` because several events can legitimately
 * share one block; the caller only needs to check each affected height
 * once.
 */
export async function findPendingBlockHashes(
  client: Queryable,
  chainId: number,
): Promise<PendingBlockHash[]> {
  const { rows } = await client.query<{ block_number: string; block_hash: string }>(
    `SELECT DISTINCT block_number, block_hash FROM chain_indexed_events
      WHERE chain_id = $1 AND confirmation_status = 'PENDING_CONFIRMATION'
      ORDER BY block_number ASC`,
    [chainId],
  );
  return rows.map((row) => ({
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash,
  }));
}

/**
 * F-1808 / AC-1805 (T-1807): rolls back every `PENDING_CONFIRMATION` event
 * at or after a detected reorg height — design.md decision 3's own scope
 * boundary: "删除该区块及之后全部待确认事件，从该高度重新扫描" (delete
 * that block and every later PENDING event, rescan from there). Never
 * touches `CONFIRMED` rows, for the same reason `findPendingBlockHashes`
 * only reads PENDING ones. Idempotent write-side counterpart to
 * `insertChainIndexedEvent`'s `ON CONFLICT DO NOTHING` — the caller's own
 * rescan naturally re-inserts whatever the (possibly different) canonical
 * chain actually has at and after `fromBlockNumber`.
 */
export async function deletePendingEventsFromBlock(
  client: Queryable,
  params: { chainId: number; fromBlockNumber: bigint },
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM chain_indexed_events
      WHERE chain_id = $1
        AND confirmation_status = 'PENDING_CONFIRMATION'
        AND block_number >= $2`,
    [params.chainId, params.fromBlockNumber],
  );
  return rowCount ?? 0;
}

/**
 * F-1808 / AC-1805 (T-1807 round 1, N4 real P1 fix): the atomic
 * counterpart to calling `deletePendingEventsFromBlock` and
 * `upsertScanCheckpoint` as two separate statements — Codex review caught
 * a real crash window between those two writes: if the process exits
 * after the DELETE commits but before the checkpoint rollback does, a
 * restart resumes from the STALE (pre-rollback) checkpoint, permanently
 * skipping the very blocks whose events were just deleted. Needs a real
 * `Pool` (not the generic `Queryable` every other read/write in this file
 * accepts) because `BEGIN`/`COMMIT` only apply atomically across
 * statements issued on the SAME checked-out connection — `pool.query()`
 * calls do not share one connection.
 */
export async function rollBackReorgAtomically(
  pool: Pool,
  params: { chainId: number; fromBlockNumber: bigint },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `DELETE FROM chain_indexed_events
        WHERE chain_id = $1
          AND confirmation_status = 'PENDING_CONFIRMATION'
          AND block_number >= $2`,
      [params.chainId, params.fromBlockNumber],
    );
    await client.query(
      `INSERT INTO indexer_scan_checkpoints (chain_id, last_scanned_block)
       VALUES ($1, $2)
       ON CONFLICT (chain_id) DO UPDATE
         SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = now()`,
      [params.chainId, params.fromBlockNumber - 1n],
    );
    await client.query("COMMIT");
    return rowCount ?? 0;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection itself may already be unusable — the outer catch's
      // own rethrow is what matters; a failed ROLLBACK here must not mask
      // the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}
