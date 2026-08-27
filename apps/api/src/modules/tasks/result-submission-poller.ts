import type { Pool } from "pg";
import type { ChainRpcClient } from "../chain/rpc.client.js";
import { checkProjectionForReorg } from "../chain/event-sync.js";
import type { ResultSubmittedLogScanner } from "../chain/result-submitted-log-scanner.js";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import {
  deletePendingResultSubmission,
  insertPendingResultSubmission,
  listAcceptedTasksForPolling,
  listPendingResultSubmissions,
} from "./repository.js";
import { resolveRequiredConfirmations, verifyResultSubmission } from "./service.js";

export interface PollResultSubmittedEventsParams {
  pool: Pool;
  rpc: ChainRpcClient;
  scanner: ResultSubmittedLogScanner;
  contractAddress: `0x${string}`;
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface PollResultSubmittedEventsSummary {
  candidatesFound: number;
  newlyPending: number;
  transitioned: number;
  rolledBack: number;
  errors: Array<{ taskId: string; message: string }>;
}

/**
 * Forward-scan half (T-905 round 1's original fix, unchanged in shape):
 * re-derives every currently-`ACCEPTED` task's on-chain id, scans the given
 * block range for `ResultSubmitted` logs, and for each log matching one of
 * those tasks, inserts (idempotently) a `pending_result_submissions` row —
 * NOT a direct call into `verifyResultSubmission` anymore (human review
 * round B: a log discovered this tick may not yet be at
 * `resolveRequiredConfirmations()`; promotion is the separate pass below,
 * `promotePendingResultSubmissions`, which only acts once a row has
 * actually reached that threshold).
 *
 * A log whose `taskId` doesn't match any currently-`ACCEPTED` task is
 * silently skipped — routine, not an error: it could be for a task this
 * poll's own snapshot no longer sees as `ACCEPTED` (already promoted by an
 * earlier tick or the HTTP path), or a different deployment's task.
 */
async function discoverPendingResultSubmissions(
  params: PollResultSubmittedEventsParams,
  summary: PollResultSubmittedEventsSummary,
): Promise<void> {
  const acceptedTasks = await listAcceptedTasksForPolling(params.pool);
  if (acceptedTasks.length === 0) {
    return;
  }

  const onChainIdToTask = new Map(
    acceptedTasks.map((task) => [deriveOnChainTaskId(task.id).toLowerCase(), task]),
  );

  const logs = await params.scanner.scanResultSubmittedLogs({
    contractAddress: params.contractAddress,
    fromBlock: params.fromBlock,
    toBlock: params.toBlock,
  });

  for (const log of logs) {
    const task = onChainIdToTask.get(log.taskId.toLowerCase());
    if (!task) {
      continue;
    }
    summary.candidatesFound += 1;
    try {
      // Human N4 follow-up (round B, P2): only count a GENUINE new pending
      // row. This poller always re-scans its full block range every tick
      // (no cursor), so the same log is rediscovered every tick after its
      // first — `insertPendingResultSubmission` reports whether ITS OWN
      // insert actually happened (vs. a no-op `ON CONFLICT`), and only that
      // real outcome increments `newlyPending`.
      const inserted = await insertPendingResultSubmission(params.pool, {
        taskId: task.id,
        chainId: params.chainId,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        blockHash: log.blockHash,
        blockNumber: log.blockNumber,
        agentAddress: log.agent,
      });
      if (inserted) {
        summary.newlyPending += 1;
      }
    } catch (error) {
      summary.errors.push({
        taskId: task.id,
        message: error instanceof Error ? error.message : "unknown pending-insert error",
      });
    }
  }
}

/**
 * Human N4 follow-up (T-905, round B, pure human review — round cap
 * already exhausted, no 3rd Codex call): the promotion + reorg-rollback
 * pass, now operating on `pending_result_submissions` instead of the dead
 * `chain_events`-based design round A built. This is the fix for both
 * AC-906 (reorg rollback of a not-yet-final projection) AND the earlier
 * P1 (a client-triggered-only endpoint isn't a real event pipeline) —
 * unified into one pass, since "not yet confirmed" is now a real,
 * naturally-occurring state a pending row can be in (unlike the old
 * design, where by the time any row existed it was already final).
 *
 * Every currently-pending row is evaluated in TWO ordered steps (human N4
 * follow-up, round B, P2 — the canonical check must run BEFORE the
 * confirmations branch, not only when confirmations are still below
 * threshold): if this were reversed, a row reorged away while it was still
 * unconfirmed could survive to a LATER tick where the block height has by
 * then crossed the confirmation threshold — the old ordering would skip
 * the reorg check entirely at that point (it only ran in the
 * below-threshold branch) and call `verifyResultSubmission` directly.
 * That call would fail safely (the receipt/log it re-fetches would no
 * longer match), but the stale pending row would never be deleted and
 * would be retried, uselessly, every tick forever.
 *
 *   1. ALWAYS reorg-checked first, regardless of confirmations, via
 *      `event-sync.ts`'s `checkProjectionForReorg` (the ONE reorg rule
 *      this codebase uses, not a second one invented here). If its
 *      recorded block is no longer canonical, the row is deleted —
 *      `tasks.status` never changed because of it, so there is nothing
 *      else to unwind. A later tick's forward scan will naturally
 *      discover whatever canonical log (if any) replaces it, inserting a
 *      fresh pending row — the SAME scan path handles both the original
 *      discovery and any post-reorg rediscovery, no second code path.
 *   2. Only once confirmed still-canonical: `confirmations <
 *      resolveRequiredConfirmations()` just waits for a later tick;
 *      `confirmations >= resolveRequiredConfirmations()` is promotable —
 *      calls the already-N4-reviewed `verifyResultSubmission`
 *      (tasks/service.ts), the ONE place "what a verified
 *      ResultSubmitted event does to a task row" is owned, regardless of
 *      how the event was discovered (CLAUDE.md 原则 6). The pending row's
 *      own `agent_address` is passed as `verifyResultSubmission`'s
 *      `sessionAddress` — safe for the same reason the old forward-scan's
 *      direct call was: `submitResult` (TaskEscrow.sol) already enforces
 *      `task.agent == msg.sender` on-chain, so a real decoded event's
 *      `agent` is guaranteed to equal this value. Deleted only on
 *      `result.ok === true` — a non-ok result (e.g. `conflict`, a
 *      transient `chain_error`) leaves the row in place for a later tick
 *      to retry, rather than losing track of it.
 *
 * Errors are collected per-row, never aborting the whole pass, so one bad
 * row can never block every other row's own progress (same posture as the
 * old forward-scan's per-task error collection).
 */
async function promotePendingResultSubmissions(
  params: Pick<PollResultSubmittedEventsParams, "pool" | "rpc" | "chainId">,
  summary: PollResultSubmittedEventsSummary,
): Promise<void> {
  const requiredConfirmations = BigInt(resolveRequiredConfirmations());
  const pendingRows = await listPendingResultSubmissions(params.pool, params.chainId);
  if (pendingRows.length === 0) {
    return;
  }

  const currentBlock = await params.rpc.getBlockNumber();

  for (const pending of pendingRows) {
    try {
      const shouldRollback = await checkProjectionForReorg(params.rpc, {
        blockNumber: pending.blockNumber,
        blockHash: pending.blockHash,
      });
      if (shouldRollback) {
        await deletePendingResultSubmission(params.pool, pending.id);
        summary.rolledBack += 1;
        continue;
      }

      const confirmations = currentBlock - pending.blockNumber + 1n;
      if (confirmations < requiredConfirmations) {
        continue;
      }

      const result = await verifyResultSubmission(
        params.pool,
        // No authenticated session exists for a poller-discovered event —
        // see the module-level doc comment above for why passing the
        // pending row's own recorded `agentAddress` here is safe.
        params.rpc,
        pending.agentAddress,
        pending.taskId,
        pending.transactionHash,
      );
      if (result.ok) {
        summary.transitioned += 1;
        await deletePendingResultSubmission(params.pool, pending.id);
      }
      // A non-ok result ("not_found"/"conflict"/"chain_error") is routine —
      // leave the row for a later tick to retry rather than deleting it
      // (e.g. a transient RPC hiccup should not lose this pending event).
    } catch (error) {
      summary.errors.push({
        taskId: pending.taskId,
        message: error instanceof Error ? error.message : "unknown promotion/reorg error",
      });
    }
  }
}

/**
 * T-905's actual event-consumption entry point. Runs the forward-scan
 * discovery pass first (adds newly-seen logs as pending rows), then the
 * promotion/reorg pass (advances or rolls back every currently-pending
 * row) — in that order each tick, so a log discovered THIS tick is at
 * least eligible for the SAME tick's promotion pass if it happens to
 * already be past the confirmation threshold (e.g. a long gap between
 * ticks), rather than always waiting a full extra tick.
 */
export async function pollResultSubmittedEvents(
  params: PollResultSubmittedEventsParams,
): Promise<PollResultSubmittedEventsSummary> {
  const summary: PollResultSubmittedEventsSummary = {
    candidatesFound: 0,
    newlyPending: 0,
    transitioned: 0,
    rolledBack: 0,
    errors: [],
  };

  await discoverPendingResultSubmissions(params, summary);
  await promotePendingResultSubmissions(params, summary);

  return summary;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface ResultSubmissionPollerHandle {
  /**
   * Human N4 follow-up (T-905, round B, P2): stops the interval AND waits
   * for any tick already in flight to finish, before resolving. `stop()`
   * previously only called `clearInterval()` — `server.ts`'s shutdown
   * sequence then proceeded straight to `app.close()`/pool teardown, so an
   * in-flight tick could still be issuing queries against an already-closed
   * pool. Awaiting this makes shutdown ordering correct: nothing that
   * depends on `pool`/`rpc` runs after this promise resolves.
   */
  stop(): Promise<void>;
}

export interface StartResultSubmissionPollerParams {
  pool: Pool;
  rpc: ChainRpcClient;
  scanner: ResultSubmittedLogScanner;
  contractAddress: `0x${string}`;
  chainId: number;
  intervalMs?: number;
  /** First block to scan from — defaults to `0n` (genesis). Every tick
   * scans `[fromBlock, currentBlock]` in full, never a trailing window (N4
   * round 2 P1, Codex — see this function's own doc comment for why a
   * fixed lookback was replaced with this). Override only if this
   * deployment's `TaskEscrow` contract's own deployment block is known and
   * scanning below it would be pure wasted RPC calls. */
  fromBlock?: bigint;
  onTick?: (summary: PollResultSubmittedEventsSummary) => void;
  onError?: (error: unknown) => void;
}

/**
 * The actual background loop `server.ts` starts once at process startup.
 * Every tick re-scans the ENTIRE range from `fromBlock` (default: genesis,
 * `0n`) to the current block — no fixed trailing lookback window, and no
 * persisted cross-restart cursor either (N4 round 2 P1, Codex): a fixed
 * window can PERMANENTLY miss a `ResultSubmitted` event mined before that
 * window if this process was down, or unable to poll, for longer than the
 * window covers. Re-scanning the full range every tick closes that gap
 * completely, and is safe to do repeatedly because
 * `insertPendingResultSubmission` is idempotent
 * (`UNIQUE (chain_id, transaction_hash, log_index)`) and
 * `verifyResultSubmission` is independently idempotent too (a `SUBMITTED`
 * task short-circuits to a replay check).
 *
 * Overlap-guarded (`running`/`stopped` flags): a tick still in flight when
 * the next interval fires is skipped rather than started concurrently, and
 * no new tick starts once `stop()` has been called (even if a timer fire
 * races the `clearInterval` call) — `currentTick` always references
 * whichever tick is presently running (or the most recently finished one),
 * so `stop()` can `await` it unconditionally.
 */
export function startResultSubmissionPoller(
  params: StartResultSubmissionPollerParams,
): ResultSubmissionPollerHandle {
  const intervalMs = params.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fromBlock = params.fromBlock ?? 0n;
  let running = false;
  let stopped = false;
  let currentTick: Promise<void> = Promise.resolve();

  const timer = setInterval(() => {
    if (running || stopped) {
      return;
    }
    running = true;
    currentTick = (async () => {
      const toBlock = await params.rpc.getBlockNumber();
      const summary = await pollResultSubmittedEvents({
        pool: params.pool,
        rpc: params.rpc,
        scanner: params.scanner,
        contractAddress: params.contractAddress,
        chainId: params.chainId,
        fromBlock,
        toBlock,
      });
      params.onTick?.(summary);
    })()
      .catch((error: unknown) => {
        params.onError?.(error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // Doesn't keep the process alive solely for this timer — matches
  // Node's own convention for background/best-effort intervals (e.g. a
  // test process that never calls `stop()` explicitly can still exit).
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await currentTick;
    },
  };
}
