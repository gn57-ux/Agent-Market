import { createChainLogScanner } from "./log-scanner.js";
import { computeRetryDelayMs, PollTickError, runPollTick } from "./indexer.js";
import { findLastConfirmedBlockNumber, findScanCheckpoint } from "./repository.js";
import { getPool } from "./db.js";
import { resolveChainId, resolveConfirmationDepth, resolveContractAddress } from "./env.js";
import { startHealthServer } from "./health-server.js";

/**
 * T-1805's process entry point, extended by T-1806 with real confirmation
 * depth + breakpoint resume (AC-1806), and by T-1807 with real reorg
 * detection/rollback (AC-1805). Deliberately still an honestly-scoped
 * skeleton for what remains:
 *
 * - No RPC-interruption recovery beyond letting a failed poll iteration's
 *   error surface and retry on the next interval — T-1808's AC-1808.
 *
 * What T-1806 adds, real and tested (this Task's own integration test):
 * - `INDEXER_CONFIRMATION_DEPTH`-driven promotion of `PENDING_CONFIRMATION`
 *   rows to `CONFIRMED` once they've accumulated enough confirmations
 *   (F-1809).
 * - Startup now resumes from `findScanCheckpoint()` + 1 — the raw "how
 *   far did the last run actually scan" breakpoint — falling back to
 *   `findLastConfirmedBlockNumber()` + 1 only if no checkpoint exists yet,
 *   and to `INDEXER_START_BLOCK`/the current chain tip only if neither
 *   exists (F-1810). `findScanCheckpoint()`, not the CONFIRMED breakpoint,
 *   is the PRIMARY signal — two rounds of real Codex findings landed here:
 *   round 1 (P1) caught that relying on the CONFIRMED breakpoint ALONE
 *   means a restart before anything has ever been confirmed falls all the
 *   way back to the current tip, silently skipping every already-scanned
 *   block and every block mined during the downtime before that tip.
 *   Round 2 (P1) then caught that the first fix — taking the SMALLER of
 *   the two breakpoints — was still wrong in the opposite direction: since
 *   a CONFIRMED row's block is by definition already scanned, the smaller
 *   of the two always reduces to the CONFIRMED breakpoint whenever one
 *   exists, and on a chain with sparse events (a real confirmed event
 *   long ago, then a long idle stretch with no matching logs but real
 *   chain activity), that CONFIRMED height can sit far behind the actual
 *   tip — resuming from it re-requests an unbounded, ever-growing
 *   `eth_getLogs` range on every restart, which real RPC providers cap,
 *   permanently failing the indexer after restart. `findScanCheckpoint()`
 *   itself has no such staleness problem: it is updated every poll tick a
 *   scan ran, even one that found zero events, so it always sits within
 *   one poll interval of the tip — a bounded, cheap resume range. It only
 *   falls back to the CONFIRMED breakpoint for the one case a checkpoint
 *   can't cover: a chain that already had CONFIRMED rows before this
 *   checkpoint table existed (a one-time migration/upgrade edge case),
 *   never for the steady-state "which of the two is more conservative"
 *   choice round 1's fix mistakenly made.
 *
 * What T-1807 adds, real and tested (design.md decision 3): every poll
 * tick, BEFORE scanning any new blocks, `detectAndRollBackReorg` checks
 * whether every still-`PENDING_CONFIRMATION` block's stored `block_hash`
 * still matches the chain's own current hash there. A mismatch means a
 * reorg replaced that block — the affected `PENDING_CONFIRMATION` rows are
 * deleted (never `CONFIRMED` ones; see `findPendingBlockHashes`'s own doc
 * comment for why the confirmation depth is this Feature's actual
 * reorg-safety boundary) and `nextFromBlock`/the scan checkpoint are both
 * rolled back to the reorg height, so the very next scan re-indexes from
 * the real, post-reorg canonical chain — atomically, via
 * `rollBackReorgAtomically` (round 1, N4 real P1 fix: the delete and the
 * checkpoint rollback used to be two separate writes with a real crash
 * window between them where a process exit after the delete but before
 * the checkpoint update would permanently strand the resume point past
 * the just-deleted blocks).
 *
 * The regular scan step below ALSO always includes the trailing
 * `confirmationDepth`-sized window on every tick, not just genuinely new
 * blocks (round 1, N4 real P1 fix): `detectAndRollBackReorg` alone only
 * catches a reorg at a height that already has a stored row to compare a
 * hash against — a reorg that replaces a previously-EMPTY block (zero
 * matching events, so no row and no stored hash ever existed there) with
 * one that now DOES contain a real event has nothing for the hash check
 * to catch, and the scan checkpoint has already moved past that height.
 * Re-scanning the whole window every tick closes that gap —
 * `indexBlockRange`'s own idempotent insert makes re-covering
 * already-indexed ground a cheap no-op.
 *
 * T-1807 round 2 (N4 real P1 fix): `runPollTick` below used to run
 * directly inside the loop with no try/catch — any rejection (a
 * transient RPC/database error, exactly the class of failure this
 * header's own text already claimed would just "surface and retry on the
 * next interval") instead propagated all the way to `main().catch()`,
 * which calls `process.exit(1)` — silently making the claimed retry
 * behavior false and stopping indexing indefinitely until an external
 * supervisor happened to restart the process. The loop below now catches
 * a failed tick, logs it, and retries on the next interval — making that
 * claim true.
 *
 * What T-1808 adds, real and tested:
 * - F-1812 / AC-1808 "按退避策略重连": `computeRetryDelayMs` (indexer.ts)
 *   doubles the retry delay on each CONSECUTIVE tick failure, capped at
 *   `MAX_RETRY_DELAY_MS`, resetting to `POLL_INTERVAL_MS` the moment a
 *   tick succeeds — a genuinely down RPC provider gets backed off rather
 *   than hammered at a fixed interval forever.
 * - F-1812 / AC-1808 "长时间中断后能追上落后的区块高度": `runPollTick`
 *   (indexer.ts) now scans a wide catch-up range in
 *   `MAX_BLOCK_RANGE_PER_SCAN`-sized chunks (`scanRangeInChunks`),
 *   persisting the scan checkpoint after EACH chunk — a long interruption
 *   followed by recovery no longer risks one oversized `eth_getLogs` call
 *   a real provider would reject, and a failure partway through a large
 *   backlog resumes from the last completed chunk, not from scratch.
 * - F-1811 / AC-1807 "事件重放": `scripts/replay.ts` (`replayEvents`,
 *   indexer.ts) — a separate, operator-triggered CLI, not part of this
 *   loop; see that script's own header comment.
 */
const POLL_INTERVAL_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

async function main(): Promise<void> {
  const scanner = createChainLogScanner(process.env);
  const pool = getPool();
  const contractAddress = resolveContractAddress(process.env);
  const chainId = resolveChainId(process.env);
  const confirmationDepth = resolveConfirmationDepth(process.env);

  // F-1810 / AC-1806: resume from the scan checkpoint (bounded, always
  // near the tip), falling back to the CONFIRMED breakpoint only if no
  // checkpoint exists yet, and to the configured start block/current tip
  // only if neither exists. See this file's own header comment for the
  // two real Codex findings (round 1 P1, round 2 P1) that led here.
  const lastScanned = await findScanCheckpoint(pool, chainId);
  const lastConfirmed =
    lastScanned === null ? await findLastConfirmedBlockNumber(pool, chainId) : null;
  const startBlockEnv = process.env.INDEXER_START_BLOCK;
  let nextFromBlock =
    lastScanned !== null
      ? lastScanned + 1n
      : lastConfirmed !== null
        ? lastConfirmed + 1n
        : startBlockEnv
          ? BigInt(startBlockEnv)
          : await scanner.getLatestBlockNumber();

  console.log(
    `apps/indexer starting: chainId=${chainId} contractAddress=${contractAddress} ` +
      `startBlock=${nextFromBlock} confirmationDepth=${confirmationDepth} ` +
      `resumedFromScanCheckpoint=${lastScanned !== null} ` +
      `resumedFromConfirmedBreakpoint=${lastConfirmed !== null}`,
  );

  const healthPort = process.env.HEALTH_PORT ? Number(process.env.HEALTH_PORT) : 9090;
  startHealthServer(healthPort);

  let consecutiveFailures = 0;
  while (true) {
    try {
      ({ nextFromBlock } = await runPollTick({
        scanner,
        pool,
        chainId,
        contractAddress,
        confirmationDepth,
        nextFromBlock,
      }));
      // F-1812 / AC-1808 (T-1808): a real recovery resets the backoff —
      // one past outage must not keep every FUTURE tick artificially
      // delayed once the provider is healthy again.
      consecutiveFailures = 0;
    } catch (error) {
      // T-1807 round 2 (N4 real P1 fix): logged, not fatal.
      // T-1808 round 1 (N4 real P1 fix): a `PollTickError` carries the
      // REAL progress this tick made before it failed (e.g. several
      // chunks of a wide catch-up scan completing before a later one
      // fails) — using it here means the next tick resumes from there,
      // not from `nextFromBlock`'s pre-tick value, which would otherwise
      // re-scan already-completed chunks on every retry for as long as
      // the same later range kept failing.
      if (error instanceof PollTickError) {
        nextFromBlock = error.partialNextFromBlock;
      }
      consecutiveFailures += 1;
      console.error(
        `apps/indexer poll tick failed (${consecutiveFailures} consecutive), will retry:`,
        error,
      );
    }

    const delayMs = computeRetryDelayMs(POLL_INTERVAL_MS, consecutiveFailures, MAX_RETRY_DELAY_MS);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

main().catch((error: unknown) => {
  console.error("apps/indexer fatal error:", error);
  process.exit(1);
});
