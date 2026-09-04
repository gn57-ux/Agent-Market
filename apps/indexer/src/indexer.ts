import type { Pool } from "pg";
import { decodeAnyEvent } from "./decode-any-event.js";
import {
  confirmEventsUpToBlock,
  findPendingBlockHashes,
  insertChainIndexedEvent,
  rollBackReorgAtomically,
  upsertChainIndexedEvent,
  upsertScanCheckpoint,
} from "./repository.js";
import type { ChainLogScanner } from "./log-scanner.js";
import type { Queryable } from "./db.js";

export interface IndexBlockRangeResult {
  logsScanned: number;
  eventsIndexed: number;
  /** Logs that matched none of the 9 known event types — always 0 in
   * practice once `scanLogs` is filtered to the escrow contract's own
   * address (every log it emits is one of the 9), kept here so a caller
   * can notice and investigate if that assumption is ever violated. */
  logsUndecoded: number;
}

/**
 * F-1812 / AC-1808 (T-1808): the largest single block range this indexer
 * will ever ask `eth_getLogs` for in one call. Real RPC providers commonly
 * cap that range (a common ceiling many public providers enforce is in the
 * low thousands of blocks); a long RPC interruption followed by recovery
 * — or a manual historical replay (F-1811) — can easily need to cover a
 * FAR wider span than that in one catch-up pass. `scanRangeInChunks` below
 * is what actually enforces this, splitting a wide range into sequential
 * calls no wider than this constant rather than ever risking one
 * oversized `eth_getLogs` call that a real provider would simply reject.
 */
export const MAX_BLOCK_RANGE_PER_SCAN = 2_000n;

/**
 * T-1805's own scope: scan one already-known block range and write every
 * decoded event into `chain_indexed_events`. Does NOT decide `fromBlock`/
 * `toBlock` itself (that's `main.ts`'s own loop, using T-1806's
 * `findLastConfirmedBlockNumber` breakpoint), and does NOT detect or roll
 * back a reorg (T-1807's AC-1805) — each of those is real,
 * separately-scoped, separately-reviewed work (CLAUDE.md 原则 9).
 *
 * `writeMode` (T-1808 round 2, N4 real P1+P2 fix) picks the persistence
 * strategy: `"insert"` (the default, `insertChainIndexedEvent`'s `ON
 * CONFLICT DO NOTHING`) is what `main.ts`'s own continuously-running poll
 * loop uses — additive and idempotent, a re-scan of already-covered
 * ground is always a safe no-op. `"upsert"` (`upsertChainIndexedEvent`'s
 * `ON CONFLICT DO UPDATE`, only for `replayEvents`) is what an
 * operator-triggered manual replay needs instead — see
 * `upsertChainIndexedEvent`'s own doc comment for why an earlier
 * "delete the range first, then re-scan" design was a real bug (round 1
 * N4 findings) this parameter exists to replace, not layer on top of.
 */
export async function indexBlockRange(params: {
  scanner: ChainLogScanner;
  client: Queryable;
  chainId: number;
  contractAddress: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  writeMode?: "insert" | "upsert";
}): Promise<IndexBlockRangeResult> {
  const logs = await params.scanner.scanLogs({
    contractAddress: params.contractAddress,
    fromBlock: params.fromBlock,
    toBlock: params.toBlock,
  });

  const isUpsert = params.writeMode === "upsert";
  const write = isUpsert ? upsertChainIndexedEvent : insertChainIndexedEvent;

  let eventsIndexed = 0;
  let logsUndecoded = 0;
  for (const log of logs) {
    const decoded = decodeAnyEvent(log);
    if (!decoded) {
      logsUndecoded += 1;
      continue;
    }
    const freshlyInserted = await write(params.client, {
      chainId: params.chainId,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventType: decoded.eventType,
      decodedPayload: decoded.payload,
    });
    // "insert" mode: only count genuinely NEW rows (matches this
    // function's original, still-relied-on semantics for the hot poll
    // path). "upsert" mode: every successfully decoded log was written
    // (as a fresh row or a correction) — replay's own callers care about
    // "how many real events did this range cover", not "how many were
    // brand new" (a corrected-but-pre-existing row is just as much a real
    // processed event as a new one).
    if (isUpsert || freshlyInserted) eventsIndexed += 1;
  }

  return { logsScanned: logs.length, eventsIndexed, logsUndecoded };
}

/**
 * F-1812 / AC-1808, F-1811 / AC-1807 (T-1808): scans `[fromBlock,
 * toBlock]` in sequential chunks no wider than `MAX_BLOCK_RANGE_PER_SCAN`
 * — the shared mechanism both a long RPC-outage catch-up (`runPollTick`
 * below) and a manual historical replay (`replayEvents`, `scripts/
 * replay.ts`) need for the identical reason: a wide-enough range in one
 * `eth_getLogs` call risks exceeding a real provider's own range limit.
 * `onChunkIndexed`, if given, is awaited after EACH chunk (not just once
 * at the end) — `runPollTick`'s own caller uses this to persist the scan
 * checkpoint incrementally, so a failure partway through a large backlog
 * does not lose already-caught-up progress (the next tick resumes from
 * the last successfully-completed chunk, not from `fromBlock` again).
 */
export async function scanRangeInChunks(params: {
  scanner: ChainLogScanner;
  client: Queryable;
  chainId: number;
  contractAddress: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  writeMode?: "insert" | "upsert";
  onChunkIndexed?: (chunkToBlock: bigint) => Promise<void>;
}): Promise<IndexBlockRangeResult> {
  let logsScanned = 0;
  let eventsIndexed = 0;
  let logsUndecoded = 0;

  let chunkFrom = params.fromBlock;
  while (chunkFrom <= params.toBlock) {
    const chunkTo = chunkFrom + MAX_BLOCK_RANGE_PER_SCAN - 1n;
    const chunkToBlock = chunkTo < params.toBlock ? chunkTo : params.toBlock;

    const result = await indexBlockRange({
      scanner: params.scanner,
      client: params.client,
      chainId: params.chainId,
      contractAddress: params.contractAddress,
      fromBlock: chunkFrom,
      toBlock: chunkToBlock,
      writeMode: params.writeMode,
    });
    logsScanned += result.logsScanned;
    eventsIndexed += result.eventsIndexed;
    logsUndecoded += result.logsUndecoded;

    if (params.onChunkIndexed) {
      await params.onChunkIndexed(chunkToBlock);
    }

    chunkFrom = chunkToBlock + 1n;
  }

  return { logsScanned, eventsIndexed, logsUndecoded };
}

/**
 * F-1811 / AC-1807 (T-1808): "支持手动触发'从某个历史区块重新索引到当前'，
 * 用于修复 bug 后回填正确的事件记录". A thin wrapper around
 * `scanRangeInChunks` with `writeMode: "upsert"` — real logic lives in
 * `upsertChainIndexedEvent` (its own doc comment covers the full
 * reasoning), so this function's only job is passing that mode through.
 *
 * Round 1's original design deleted the whole range FIRST, then re-scanned
 * it — real Codex findings (round 1: P1, P2) caught that this was
 * genuinely unsafe: the delete committed immediately, but the re-scan does
 * slow, multi-chunk, real-network calls afterward, so any failure partway
 * through (RPC error, DB error, a killed process) could leave a
 * historical range permanently EMPTY — ordinary polling never revisits
 * blocks outside its own trailing confirmation window, so nothing would
 * ever refill it. Deleting also reset every row (even already-`CONFIRMED`
 * ones) back to the table's default `PENDING_CONFIRMATION`, silently
 * demoting real, already-final history. `writeMode: "upsert"` replaces
 * that design entirely: each row transitions from its old content to its
 * new content in ONE atomic `UPDATE`, touching only `event_type`/
 * `decoded_payload` — a row is never gone even briefly (a failure partway
 * through a wide replay leaves not-yet-reached rows exactly as they were,
 * never missing), and `confirmation_status` is never disturbed (a
 * `CONFIRMED` row replayed for a decode-bug fix stays `CONFIRMED`).
 *
 * AC-1807's own repeatability requirement ("重放结果与首次索引结果一致")
 * holds for correct data for the same reason `insertChainIndexedEvent`'s
 * `ON CONFLICT DO NOTHING` makes the additive scan path repeatable:
 * re-upserting identical content is a genuine no-op in effect (the row's
 * own `id` and `confirmation_status` do not change at all across a
 * replay, unlike the round 1 delete-based design).
 *
 * `scripts/replay.ts` is this function's only real caller (an
 * operator-triggered CLI, not something `main.ts`'s own poll loop ever
 * calls itself — the hot path always uses `writeMode: "insert"`,
 * CLAUDE.md 原则 9: this is real, separately-scoped behavior, not layered
 * onto it).
 */
export async function replayEvents(params: {
  scanner: ChainLogScanner;
  client: Queryable;
  chainId: number;
  contractAddress: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<IndexBlockRangeResult> {
  return scanRangeInChunks({ ...params, writeMode: "upsert" });
}

/**
 * F-1809 / AC-1806 (T-1806): promotes every `PENDING_CONFIRMATION` row
 * that has accumulated at least `confirmationDepth` confirmations (i.e.
 * `latestBlock - row.blockNumber >= confirmationDepth`) to `CONFIRMED`.
 * `confirmationDepth` is a real, operator-configured parameter — Q-1803
 * (requirements.md's own "开放问题") explicitly leaves the SPECIFIC number
 * undecided pending the target network's real block/reorg characteristics;
 * this function does not invent one, it only implements the mechanism
 * generically for whatever value the caller supplies (`main.ts` reads it
 * from `INDEXER_CONFIRMATION_DEPTH`, defaulting to a clearly-labeled
 * placeholder, not a silently-assumed "correct" number).
 */
export async function confirmIndexedEvents(params: {
  client: Queryable;
  chainId: number;
  latestBlock: bigint;
  confirmationDepth: bigint;
}): Promise<number> {
  const upToBlockNumber = params.latestBlock - params.confirmationDepth;
  if (upToBlockNumber < 0n) return 0;
  return confirmEventsUpToBlock(params.client, {
    chainId: params.chainId,
    upToBlockNumber,
  });
}

export interface ReorgResult {
  /** The lowest block height whose stored PENDING_CONFIRMATION row no
   * longer matches the chain's own current hash there. */
  reorgDetectedAtBlock: bigint;
  /** How many PENDING_CONFIRMATION rows at/after that height were rolled
   * back (deleted, to be re-scanned from the real, post-reorg chain). */
  eventsRolledBack: number;
}

/**
 * F-1808 / AC-1805 (T-1807): design.md decision 3's own reorg-detection
 * check — "每次扫描前先检查'待确认事件'对应的区块哈希是否仍然是链上该高度
 * 的规范区块". Checks every still-PENDING_CONFIRMATION block height
 * ascending and stops at the FIRST mismatch (a lower height's reorg
 * implies every higher pending height needs re-scanning too, regardless
 * of whether ITS OWN stored hash happens to still match — a reorg that
 * replaces block N can coincidentally reproduce the same hash at block
 * N+1 only if nothing real changed there, which the caller cannot safely
 * assume). Returns `null` when no pending block's hash has changed — the
 * common case, checked every poll tick before `indexBlockRange` decides
 * `fromBlock` (T-1805/T-1806's own scan step), so a real reorg is caught
 * before it could otherwise be silently scanned over.
 *
 * Deliberately never inspects `CONFIRMED` rows — see
 * `findPendingBlockHashes`'s own doc comment for why treating the
 * confirmation depth as the actual reorg-safety boundary is this
 * Feature's own established design, not an oversight.
 *
 * Takes a real `Pool` (not the generic `Queryable` most functions in this
 * file accept) — `rollBackReorgAtomically`'s own atomicity requirement
 * (round 1, N4 real P1 fix) needs a checked-out connection, which only a
 * `Pool` can provide via `.connect()`.
 *
 * IMPORTANT: this function alone does not catch a reorg that replaces a
 * previously-EMPTY block (one that produced zero matching events, so no
 * `chain_indexed_events` row — and thus no stored hash — ever existed for
 * it) with one that now DOES contain a real event; there is nothing here
 * to compare against for a height with no row. `main.ts`'s own poll loop
 * closes that gap by unconditionally re-scanning the whole
 * `confirmationDepth`-sized window on every tick (not just genuinely-new
 * blocks) — `indexBlockRange`'s own `ON CONFLICT DO NOTHING` makes
 * re-scanning already-covered ground a cheap no-op, and a newly-appeared
 * event in a previously-empty height gets picked up by that re-scan
 * exactly like a brand-new block would (round 1, N4 real P1 fix — see
 * `main.ts`'s own doc comment for the full reasoning).
 */
export async function detectAndRollBackReorg(params: {
  scanner: ChainLogScanner;
  pool: Pool;
  chainId: number;
}): Promise<ReorgResult | null> {
  const pendingBlocks = await findPendingBlockHashes(params.pool, params.chainId);
  for (const pending of pendingBlocks) {
    const currentHash = await params.scanner.getBlockHash(pending.blockNumber);
    if (currentHash !== pending.blockHash) {
      const eventsRolledBack = await rollBackReorgAtomically(params.pool, {
        chainId: params.chainId,
        fromBlockNumber: pending.blockNumber,
      });
      return { reorgDetectedAtBlock: pending.blockNumber, eventsRolledBack };
    }
  }
  return null;
}

/**
 * T-1808 round 1 (N4 real P1 fix): thrown by `runPollTick` instead of a
 * plain `Error` so `main.ts`'s own catch block can recover exactly how
 * far this tick actually got before it failed — see `runPollTick`'s own
 * doc comment for why a plain propagated error was not enough on its own.
 */
export class PollTickError extends Error {
  readonly partialNextFromBlock: bigint;

  constructor(message: string, partialNextFromBlock: bigint, options?: ErrorOptions) {
    super(message, options);
    this.name = "PollTickError";
    this.partialNextFromBlock = partialNextFromBlock;
  }
}

/**
 * One poll iteration's full body — reorg check, scan (including the
 * confirmation-window re-scan), and confirmation promotion. Lives here
 * (not in `main.ts`) specifically so it can be imported by tests without
 * triggering `main.ts`'s own unconditional `main()` invocation at module
 * load (a process entry point, not a library — importing it would start a
 * real indexer loop against a real DB connection; see `env.ts`'s own
 * header comment for the identical reason its own helpers were pulled out
 * for T-1806).
 *
 * T-1807 round 2 (N4 real P1 fix): this function's own errors are NOT
 * swallowed here — they still propagate to the caller (`main.ts`'s own
 * loop wraps this call in try/catch, logging and retrying next interval,
 * rather than letting a transient RPC/database failure escape all the way
 * to `main().catch()`'s `process.exit(1)`).
 *
 * T-1808 round 1 (N4 real P1 fix): a failure is now thrown as a
 * `PollTickError` carrying `partialNextFromBlock` — the real progress
 * made before the failure, tracked in the SAME local `nextFromBlock`
 * variable this function always used, just no longer discarded when the
 * function throws instead of returning. Without this, a wide catch-up
 * scan (`scanRangeInChunks`) that completes several chunks and then fails
 * on a LATER one would persist the scan checkpoint for those completed
 * chunks (via `onChunkIndexed`) while the CALLER's own `nextFromBlock`
 * stayed at its pre-tick value — the next tick would then recompute
 * `scanFromBlock` from that stale value and re-scan the very chunks that
 * had already succeeded, on every retry, for as long as the SAME later
 * range kept failing: real, wasted work, and not the "incremental
 * catch-up" this Task's own AC-1808 promises. `main.ts` now reads
 * `error.partialNextFromBlock` in its own catch block and uses it instead
 * of leaving `nextFromBlock` untouched.
 */
export async function runPollTick(params: {
  scanner: ChainLogScanner;
  pool: Pool;
  chainId: number;
  contractAddress: `0x${string}`;
  confirmationDepth: bigint;
  nextFromBlock: bigint;
}): Promise<{ nextFromBlock: bigint }> {
  const { scanner, pool, chainId, contractAddress, confirmationDepth } = params;
  let nextFromBlock = params.nextFromBlock;

  try {
    // F-1808 / AC-1805 (T-1807): checked before every scan step — a reorg
    // affecting a still-pending block must roll back and re-scan from
    // there before this tick decides what range to index next.
    const reorg = await detectAndRollBackReorg({ scanner, pool, chainId });
    if (reorg) {
      console.log(
        `reorg detected at block ${reorg.reorgDetectedAtBlock}: rolled back ` +
          `${reorg.eventsRolledBack} pending event(s), re-scanning from there`,
      );
      nextFromBlock = reorg.reorgDetectedAtBlock;
    }

    const latest = await scanner.getLatestBlockNumber();
    // T-1807 round 1 (N4 real P1 fix): always include the trailing
    // confirmationDepth-sized window in the scan range, not just
    // genuinely-new blocks — see `detectAndRollBackReorg`'s own doc
    // comment for why the hash-comparison reorg check alone cannot catch
    // a previously-empty block gaining a real event via reorg.
    const windowStart = latest - confirmationDepth + 1n;
    const boundedWindowStart = windowStart > 0n ? windowStart : 0n;
    const scanFromBlock = nextFromBlock < boundedWindowStart ? nextFromBlock : boundedWindowStart;
    if (latest >= scanFromBlock) {
      // F-1812 / AC-1808 (T-1808): chunked, not one unbounded
      // `indexBlockRange` call — after a long RPC interruption,
      // `latest - scanFromBlock` can be far wider than any real
      // provider's own `eth_getLogs` range limit. `onChunkIndexed`
      // persists the scan checkpoint AND updates this function's own
      // `nextFromBlock` after EACH chunk (round 1, N4 real P1 fix) — so a
      // failure partway through a large catch-up backlog (surfaced below
      // via `PollTickError`) reports real progress up through the last
      // successfully-indexed chunk, not just the pre-tick starting point.
      const result = await scanRangeInChunks({
        scanner,
        client: pool,
        chainId,
        contractAddress,
        fromBlock: scanFromBlock,
        toBlock: latest,
        onChunkIndexed: async (chunkToBlock) => {
          await upsertScanCheckpoint(pool, { chainId, lastScannedBlock: chunkToBlock });
          nextFromBlock = chunkToBlock + 1n;
        },
      });
      if (result.logsScanned > 0) {
        console.log(
          `indexed blocks ${scanFromBlock}-${latest}: scanned=${result.logsScanned} ` +
            `indexed=${result.eventsIndexed} undecoded=${result.logsUndecoded}`,
        );
      }
      nextFromBlock = latest + 1n;
    }

    const confirmedCount = await confirmIndexedEvents({
      client: pool,
      chainId,
      latestBlock: latest,
      confirmationDepth,
    });
    if (confirmedCount > 0) {
      console.log(`confirmed ${confirmedCount} previously-pending event(s)`);
    }

    return { nextFromBlock };
  } catch (error) {
    throw new PollTickError(
      `poll tick failed after making progress up to block ${nextFromBlock - 1n}`,
      nextFromBlock,
      { cause: error },
    );
  }
}

/**
 * F-1812 / AC-1808 (T-1808): "按退避策略重连" — a pure, fully-parameterized
 * function (no hidden module-level constants) so it can be unit-tested
 * directly. Doubles the delay on each consecutive failure (1x, 2x, 4x,
 * 8x, ... of `baseIntervalMs`), capped at `maxDelayMs` — a real Hardhat
 * node or transient RPC hiccup typically self-resolves within seconds,
 * but repeated immediate retries against a GENUINELY down provider would
 * otherwise just hammer it at the same fixed interval forever; backing
 * off reduces that load while `runPollTick`'s own per-tick behavior
 * (round 2, N4 real P1 fix) already guarantees the process itself never
 * exits because of it. Resets to `baseIntervalMs` the moment a tick
 * succeeds (the caller passes `consecutiveFailures = 0` again) — this
 * function has no memory of its own between calls.
 */
export function computeRetryDelayMs(
  baseIntervalMs: number,
  consecutiveFailures: number,
  maxDelayMs: number,
): number {
  if (consecutiveFailures <= 0) return baseIntervalMs;
  const backoff = baseIntervalMs * 2 ** consecutiveFailures;
  return backoff < maxDelayMs ? backoff : maxDelayMs;
}
