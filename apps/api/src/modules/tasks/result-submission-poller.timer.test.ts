import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ChainRpcClient } from "../chain/rpc.client.js";
import type { ResultSubmittedLogScanner } from "../chain/result-submitted-log-scanner.js";
import { startResultSubmissionPoller } from "./result-submission-poller.js";

/**
 * N4 round 2 P1 fix (Codex): `startResultSubmissionPoller` must scan from
 * genesis (`fromBlock: 0n`) by default on every tick, never a fixed
 * trailing window — this is a pure unit test of that one behavior (no real
 * Postgres needed).
 *
 * `pollResultSubmittedEvents` now issues TWO different queries per tick
 * (discovery's `listAcceptedTasksForPolling`, then promotion's
 * `listPendingResultSubmissions`) — this fake pool distinguishes them by
 * SQL text so each returns the shape its own real caller expects, rather
 * than one mock blindly answering both with the same rows.
 */
function buildFakePool(acceptedTaskRows: unknown[]): Pool {
  return {
    query: vi.fn((sql: string) => {
      if (typeof sql === "string" && sql.includes("pending_result_submissions")) {
        // The promotion/reorg pass's query — no pending rows in any of
        // these tests (they only exercise the forward-scan/genesis-window
        // and stop()-draining behaviors).
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: acceptedTaskRows });
    }),
  } as unknown as Pool;
}

function buildFakeRpc(currentBlock: bigint): ChainRpcClient {
  return {
    async getTransactionReceipt() {
      return null;
    },
    async getBlockNumber() {
      return currentBlock;
    },
    async getBlock() {
      return null;
    },
    async getChainId() {
      return 31337;
    },
    async getTransaction() {
      return null;
    },
    async readStakeRateBps() {
      throw new Error("not used");
    },
    async readAuthorizedSigner() {
      throw new Error("not used");
    },
    async readHasRole() {
      throw new Error("not used");
    },
  };
}

const ACCEPTED_TASK_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  accepted_agent_address: "0xabc",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startResultSubmissionPoller", () => {
  it("scans from genesis (fromBlock: 0n) by default, even when the chain is far past block 1000", async () => {
    // A block height far beyond any fixed lookback window a prior version
    // of this poller might have used — proves there is no such window
    // left: an event mined long before "current - 1000" must still be
    // reachable, since fromBlock stays 0n regardless of how high the
    // chain has grown. A non-empty accepted-tasks stub is required so
    // `pollResultSubmittedEvents` actually reaches the scanner call this
    // test observes (an empty accepted-tasks set short-circuits before
    // ever calling the scanner — see the dedicated integration test for
    // that separate behavior).
    const CURRENT_BLOCK = 50_000n;
    const rpc = buildFakeRpc(CURRENT_BLOCK);
    const pool = buildFakePool([ACCEPTED_TASK_ROW]);
    const scanCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const scanner: ResultSubmittedLogScanner = {
      async scanResultSubmittedLogs(params) {
        scanCalls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock });
        return [];
      },
    };

    const handle = startResultSubmissionPoller({
      pool,
      rpc,
      scanner,
      contractAddress: "0x1234567890123456789012345678901234567890",
      chainId: 31337,
      intervalMs: 1000,
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      await handle.stop();
    }

    expect(scanCalls).toEqual([{ fromBlock: 0n, toBlock: CURRENT_BLOCK }]);
  });

  it("respects an explicit fromBlock override when provided", async () => {
    const CURRENT_BLOCK = 50_000n;
    const rpc = buildFakeRpc(CURRENT_BLOCK);
    const pool = buildFakePool([ACCEPTED_TASK_ROW]);
    const scanCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const scanner: ResultSubmittedLogScanner = {
      async scanResultSubmittedLogs(params) {
        scanCalls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock });
        return [];
      },
    };

    const handle = startResultSubmissionPoller({
      pool,
      rpc,
      scanner,
      contractAddress: "0x1234567890123456789012345678901234567890",
      chainId: 31337,
      intervalMs: 1000,
      fromBlock: 12_345n,
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      await handle.stop();
    }

    expect(scanCalls).toEqual([{ fromBlock: 12_345n, toBlock: CURRENT_BLOCK }]);
  });

  // Human N4 follow-up (T-905, round-cap already exhausted, pure human
  // review): requirement #7 — `stop()` must actually stop the interval,
  // so a leftover timer never keeps firing after shutdown (e.g. against a
  // pool that has already been closed).
  it("stop() actually stops the interval — no further ticks fire after it is called", async () => {
    const CURRENT_BLOCK = 50_000n;
    const rpc = buildFakeRpc(CURRENT_BLOCK);
    const pool = buildFakePool([ACCEPTED_TASK_ROW]);
    const scanCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const scanner: ResultSubmittedLogScanner = {
      async scanResultSubmittedLogs(params) {
        scanCalls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock });
        return [];
      },
    };

    const handle = startResultSubmissionPoller({
      pool,
      rpc,
      scanner,
      contractAddress: "0x1234567890123456789012345678901234567890",
      chainId: 31337,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(scanCalls).toHaveLength(1);

    await handle.stop();
    // Advance well past several more would-be intervals — if `stop()`
    // didn't actually clear the timer, this would produce more scan
    // calls.
    await vi.advanceTimersByTimeAsync(5000);
    expect(scanCalls).toHaveLength(1);
  });

  // Human N4 follow-up (T-905, round B, P2, pure human review): `stop()`
  // must actually WAIT for an in-flight tick to finish, not just clear the
  // timer — otherwise `server.ts`'s shutdown sequence can proceed to
  // `app.close()`/pool teardown while a tick is still mid-query against
  // that same pool. This test blocks a tick deliberately (a scanner call
  // that doesn't resolve until the test releases it) and proves `stop()`'s
  // own returned promise does not resolve until that tick genuinely
  // completes.
  it("stop() waits for an in-flight tick to finish before resolving", async () => {
    const CURRENT_BLOCK = 50_000n;
    const rpc = buildFakeRpc(CURRENT_BLOCK);
    const pool = buildFakePool([ACCEPTED_TASK_ROW]);

    let releaseTick: (() => void) | undefined;
    const tickBlocked = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    let tickStarted = false;
    let tickFinished = false;
    const scanner: ResultSubmittedLogScanner = {
      async scanResultSubmittedLogs() {
        tickStarted = true;
        await tickBlocked;
        tickFinished = true;
        return [];
      },
    };

    const handle = startResultSubmissionPoller({
      pool,
      rpc,
      scanner,
      contractAddress: "0x1234567890123456789012345678901234567890",
      chainId: 31337,
      intervalMs: 1000,
    });

    // Fire the tick, but don't let fake-timer advancement itself await the
    // still-blocked scanner call.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickStarted).toBe(true);
    expect(tickFinished).toBe(false);

    let stopResolved = false;
    const stopPromise = handle.stop().then(() => {
      stopResolved = true;
    });

    // Give any wrongly-eager microtask a chance to run — stop() must still
    // not have resolved, since the tick it's waiting on is still blocked.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(tickFinished).toBe(false);

    releaseTick?.();
    await stopPromise;

    expect(tickFinished).toBe(true);
    expect(stopResolved).toBe(true);
  });
});
