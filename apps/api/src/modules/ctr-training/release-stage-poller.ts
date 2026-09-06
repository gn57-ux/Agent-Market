import type { Pool } from "pg";
import { checkAndAutoRollback, type AutoRollbackResult } from "./release-gate.js";

/**
 * T-1907 (F-1910/F-1916), N4 round 2 real finding (P1): `checkAndAutoRollback`
 * previously only ran when a human manually invoked `manage-release-stage
 * --auto-rollback` — nothing in the running process ever asked "has the
 * gate stopped passing?" on its own, so a real GRADUAL/PRIMARY regression
 * would sit unrolled-back indefinitely unless someone remembered to run the
 * CLI. This file closes that gap the same way T-905/T-1703 already closed
 * the identical "nothing calls the real state-transition logic on its own"
 * gap for `ResultSubmitted` event consumption and DAG advancement — see
 * `tasks/result-submission-poller.ts`'s own doc comment, whose shape
 * (overlap-guarded interval, unref'd timer, awaitable `stop()`) this file
 * deliberately mirrors rather than inventing a third polling convention
 * for the same kind of problem.
 *
 * A 5-minute default interval (vs the other pollers' 10 seconds) — a
 * release-stage health check runs real, non-trivial queries
 * (`evaluateReleaseGate` rebuilds a trailing-window training dataset from
 * `interaction_events` and scans `shadow_ranking_results`/
 * `dispatch_rerank_runs`), and a real stage regression is not a
 * sub-second-latency event the way a missed `ResultSubmitted` log is —
 * checking every 10 seconds would add real, unnecessary database load for
 * no real safety benefit.
 */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface ReleaseStagePollerHandle {
  /** Same shape as `ResultSubmissionPollerHandle.stop()`/`DagPollerHandle
   * .stop()` — stops the interval AND waits for any tick already in
   * flight to finish, so `server.ts`'s shutdown sequence never lets a
   * tick touch `pool` after this resolves. */
  stop(): Promise<void>;
}

export interface StartReleaseStagePollerParams {
  pool: Pool;
  intervalMs?: number;
  onTick?: (result: AutoRollbackResult | null) => void;
  onError?: (error: unknown) => void;
}

/**
 * The actual background loop `server.ts` starts once at process startup —
 * mirrors `result-submission-poller.ts`/`dag-poller.ts`'s established
 * shape exactly (overlap guard via `running`/`stopped` flags, unref'd
 * timer so a process that never calls `stop()` can still exit,
 * `currentTick` tracked so `stop()` can await whichever tick is in
 * flight).
 */
export function startReleaseStagePoller(
  params: StartReleaseStagePollerParams,
): ReleaseStagePollerHandle {
  const intervalMs = params.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let running = false;
  let stopped = false;
  let currentTick: Promise<void> = Promise.resolve();

  const timer = setInterval(() => {
    if (running || stopped) {
      return;
    }
    running = true;
    currentTick = checkAndAutoRollback(params.pool)
      .then((result) => {
        params.onTick?.(result);
      })
      .catch((error: unknown) => {
        params.onError?.(error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await currentTick;
    },
  };
}
