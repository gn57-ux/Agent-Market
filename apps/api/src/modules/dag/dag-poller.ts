import type { Pool } from "pg";
import { listActiveDagIds } from "./repository.js";
import { SimpleDagExecutor, type DagExecutor } from "./executor.js";

export interface DagPollTickSummary {
  dagsChecked: number;
  syncedNodeCount: number;
  activatedNodeCount: number;
  completedDagIds: string[];
  blockedDagIds: string[];
  errors: Array<{ dagId: string; message: string }>;
}

/**
 * T-1703's actual event-consumption entry point — the real "临时同步轮询"
 * design.md's interface contract and tasks.md's own risk note call for,
 * standing in for Feature 18's not-yet-built event notification. Lists
 * every currently-`ACTIVE` DAG and calls `advanceDag` (service.ts) for
 * each, one at a time (no `Promise.all` — `advanceDag` already takes a
 * real row lock per DAG; running many concurrently here would just queue
 * on the pool for no benefit, and keeps one tick's log/error accounting
 * simple to reason about).
 *
 * N4 real finding: the first version of T-1703 built `advanceDagNodes`/
 * `advanceDag` (the actual state-machine step) but never called them from
 * anything except tests — no route, no timer, nothing wired into
 * `server.ts`. Correctly caught as leaving multi-node DAGs permanently
 * stuck after their first node: a real DAG's second/third node would
 * never activate, because nothing in the running process ever asked "has
 * anything changed?" This function (and `startDagPoller` below) closes
 * that gap the same way T-905 already closed the identical gap for
 * `ResultSubmitted` event consumption — see
 * `tasks/result-submission-poller.ts`, whose `startResultSubmissionPoller`
 * this file's shape deliberately mirrors (overlap-guarded interval,
 * unref'd timer, awaitable `stop()`) rather than inventing a second
 * polling convention for the same kind of problem.
 *
 * A single DAG's error is caught and recorded per-DAG, never aborting the
 * rest of the tick — one DAG with, say, an already-expired downstream
 * deadline must not block every other DAG's own progress.
 *
 * `executor` (T-1709/Q-1701): which `DagExecutor` (executor.ts) actually
 * decides "advance this DAG" — defaults to `SimpleDagExecutor` (a direct
 * `advanceDag` call). This is the ONLY thing T-1709 changes about this
 * function: everything above about listing/error-handling/summary
 * accounting is identical regardless of which executor is plugged in,
 * because an executor's whole contract is "same inputs, same outputs" as
 * `advanceDag` itself (executor.ts's own doc comment).
 */
export async function pollDagAdvancement(
  pool: Pool,
  executor: DagExecutor = new SimpleDagExecutor(),
): Promise<DagPollTickSummary> {
  const summary: DagPollTickSummary = {
    dagsChecked: 0,
    syncedNodeCount: 0,
    activatedNodeCount: 0,
    completedDagIds: [],
    blockedDagIds: [],
    errors: [],
  };

  const dagIds = await listActiveDagIds(pool);
  for (const dagId of dagIds) {
    summary.dagsChecked += 1;
    try {
      const result = await executor.advance(pool, dagId);
      if (result.ok) {
        summary.syncedNodeCount += result.syncedNodeIds.length;
        summary.activatedNodeCount += result.activatedNodeIds.length;
        // N4 round-2 P1 fix: a fully-finished DAG transitions to
        // COMPLETED here (inside advanceDagNodes) — listActiveDagIds
        // naturally stops returning it on the NEXT tick since it's no
        // longer ACTIVE, closing the "polled forever" gap.
        if (result.dagCompleted) summary.completedDagIds.push(dagId);
        // N4 round-2 P2 fix: a blocked downstream node no longer aborts
        // the tick (see service.ts/repository.ts) — recorded here for
        // visibility, not treated as a poller error, since it names a
        // real per-node problem for a human to see via the DAG's own
        // read endpoint (T-1707), not something this tick can resolve.
        if (result.blocked) summary.blockedDagIds.push(dagId);
      }
      // A non-ok result (NOT_FOUND/NOT_ACTIVE) is routine, not a poller
      // error — NOT_ACTIVE just means another tick (or a settlement
      // mid-flight) already moved it past ACTIVE (e.g. to COMPLETED).
    } catch (error) {
      summary.errors.push({
        dagId,
        message: error instanceof Error ? error.message : "unknown DAG advancement error",
      });
    }
  }

  return summary;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface DagPollerHandle {
  /** Same shape as `ResultSubmissionPollerHandle.stop()` — stops the
   * interval AND waits for any tick already in flight to finish, so
   * `server.ts`'s shutdown sequence never lets a tick touch `pool` after
   * this resolves. */
  stop(): Promise<void>;
}

export interface StartDagPollerParams {
  pool: Pool;
  intervalMs?: number;
  /** T-1709: which `DagExecutor` this poller's ticks use — defaults to
   * `SimpleDagExecutor`. `server.ts` reads `DAG_EXECUTOR=langgraph` from
   * the environment to opt into `LangGraphDagExecutor` (langgraph-
   * executor.ts) instead, without any code change — see that file's own
   * doc comment for why swapping this can never change WHAT happens to a
   * DAG, only which code path decided to call `advanceDag`. */
  executor?: DagExecutor;
  onTick?: (summary: DagPollTickSummary) => void;
  onError?: (error: unknown) => void;
}

/**
 * The actual background loop `server.ts` starts once at process startup —
 * mirrors `result-submission-poller.ts`'s `startResultSubmissionPoller`
 * (overlap guard via `running`/`stopped` flags, unref'd timer so a
 * process that never calls `stop()` can still exit, `currentTick` tracked
 * so `stop()` can await whichever tick is in flight).
 */
export function startDagPoller(params: StartDagPollerParams): DagPollerHandle {
  const intervalMs = params.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const executor = params.executor ?? new SimpleDagExecutor();
  let running = false;
  let stopped = false;
  let currentTick: Promise<void> = Promise.resolve();

  const timer = setInterval(() => {
    if (running || stopped) {
      return;
    }
    running = true;
    currentTick = pollDagAdvancement(params.pool, executor)
      .then((summary) => {
        params.onTick?.(summary);
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
