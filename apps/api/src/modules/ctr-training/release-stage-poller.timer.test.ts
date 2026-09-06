import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { startReleaseStagePoller } from "./release-stage-poller.js";

/**
 * Pure unit test of `startReleaseStagePoller`'s own timer/overlap-guard/
 * stop() mechanics (no real Postgres) — mirrors `result-submission-
 * poller.timer.test.ts`'s established pattern exactly. Stubs
 * `release_stage_state` as always `SHADOW`, so `checkAndAutoRollback`
 * (release-gate.ts) short-circuits immediately without needing to fake
 * the full gate-evaluation query surface (`evaluateReleaseGate`'s own
 * integration test already covers that machinery against a real
 * database) — this file only proves the poller wrapper itself behaves
 * correctly.
 */
function buildFakeClient(queryLog: string[]): PoolClient {
  return {
    query: vi.fn((sql: string) => {
      queryLog.push(sql);
      if (typeof sql === "string" && sql.includes("SELECT stage FROM release_stage_state")) {
        return Promise.resolve({ rows: [{ stage: "SHADOW" }] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function buildFakePool(queryLog: string[]): Pool {
  return {
    connect: vi.fn(() => Promise.resolve(buildFakeClient(queryLog))),
  } as unknown as Pool;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startReleaseStagePoller", () => {
  it("ticks on the configured interval, calling checkAndAutoRollback", async () => {
    const queryLog: string[] = [];
    const pool = buildFakePool(queryLog);
    const ticks: unknown[] = [];

    const handle = startReleaseStagePoller({
      pool,
      intervalMs: 1000,
      onTick: (result) => ticks.push(result),
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      await handle.stop();
    }

    expect(ticks).toEqual([null]); // SHADOW -> checkAndAutoRollback is a no-op
    expect(queryLog.some((sql) => sql.includes("release_stage_state"))).toBe(true);
  });

  it("stop() actually stops the interval — no further ticks fire after it is called", async () => {
    const queryLog: string[] = [];
    const pool = buildFakePool(queryLog);
    const ticks: unknown[] = [];

    const handle = startReleaseStagePoller({
      pool,
      intervalMs: 1000,
      onTick: (result) => ticks.push(result),
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(1);

    await handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toHaveLength(1);
  });

  it("skips a tick that's still in flight rather than starting a second one concurrently", async () => {
    let releaseTick: (() => void) | undefined;
    const tickBlocked = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    let connectCount = 0;
    const pool = {
      connect: vi.fn(async () => {
        connectCount += 1;
        await tickBlocked;
        return {
          query: vi.fn(() => Promise.resolve({ rows: [{ stage: "SHADOW" }] })),
          release: vi.fn(),
        } as unknown as PoolClient;
      }),
    } as unknown as Pool;

    const handle = startReleaseStagePoller({ pool, intervalMs: 1000 });

    // Two interval fires while the first tick's connect() is still
    // blocked — the second must be skipped, not queued.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connectCount).toBe(1);

    releaseTick?.();
    await handle.stop();
  });

  it("stop() waits for an in-flight tick to finish before resolving", async () => {
    let releaseTick: (() => void) | undefined;
    const tickBlocked = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    let tickStarted = false;
    let tickFinished = false;
    const pool = {
      connect: vi.fn(async () => {
        tickStarted = true;
        await tickBlocked;
        tickFinished = true;
        return {
          query: vi.fn(() => Promise.resolve({ rows: [{ stage: "SHADOW" }] })),
          release: vi.fn(),
        } as unknown as PoolClient;
      }),
    } as unknown as Pool;

    const handle = startReleaseStagePoller({ pool, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(tickStarted).toBe(true);
    expect(tickFinished).toBe(false);

    let stopResolved = false;
    const stopPromise = handle.stop().then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    releaseTick?.();
    await stopPromise;

    expect(tickFinished).toBe(true);
    expect(stopResolved).toBe(true);
  });
});
