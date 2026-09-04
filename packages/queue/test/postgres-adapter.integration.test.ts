import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { createPostgresQueueAdapter } from "../src/postgres-adapter.js";

/**
 * Real `pg-boss` against a real PostgreSQL database — same opt-in
 * discipline every other real-DB suite in this monorepo uses
 * (`RUN_DB_INTEGRATION_TESTS=1`). Deliberately reuses whatever
 * `TEST_DATABASE_URL` already points at (this project's own dedicated
 * test database) — pg-boss creates its own `pgboss` schema inside that
 * same database, entirely separate from this project's own business
 * tables, so no additional throwaway database is needed.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

function requireConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("RUN_DB_INTEGRATION_TESTS=1 requires TEST_DATABASE_URL");
  return url;
}

runIfOptedIn("createPostgresQueueAdapter (integration, T-1801)", () => {
  // Lazy, inside beforeAll — Vitest's describe.skip still executes this
  // describe callback body to register the (skipped) test cases, but does
  // not run beforeAll/afterAll hooks declared inside it (same gotcha
  // apps/api's own `requireTestDatabaseUrl` doc comment documents).
  // Calling `requireConnectionString()` directly in the describe body
  // would throw even when this suite is genuinely skipped.
  let adapter: ReturnType<typeof createPostgresQueueAdapter>;

  beforeAll(() => {
    adapter = createPostgresQueueAdapter(requireConnectionString());
  });

  afterAll(async () => {
    await adapter.stop();
  });

  it("publishes a message and a real subscribed worker consumes it exactly once", async () => {
    const queueName = `test-queue-${randomUUID()}`;
    await adapter.createQueue(queueName);

    const received: unknown[] = [];
    let resolveReceived: () => void;
    const receivedPromise = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    await adapter.subscribe(queueName, async (message) => {
      received.push(message.payload);
      resolveReceived();
    });

    await adapter.publish(queueName, { hello: "world" });

    await Promise.race([
      receivedPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), 10_000)),
    ]);

    expect(received).toEqual([{ hello: "world" }]);
    await adapter.unsubscribe(queueName);
  }, 15_000);

  it("a handler that throws does not crash the consumer — the message becomes eligible for retry rather than being silently dropped", async () => {
    const queueName = `test-queue-fail-${randomUUID()}`;
    // pg-boss's own default retryDelay is 0 seconds (immediate retry) —
    // no need to configure it explicitly for a fast test.
    await adapter.createQueue(queueName, { retryLimit: 2 });

    let attempts = 0;
    let resolveSecondAttempt: () => void;
    const secondAttemptPromise = new Promise<void>((resolve) => {
      resolveSecondAttempt = resolve;
    });

    await adapter.subscribe(queueName, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("simulated first-attempt failure");
      }
      resolveSecondAttempt();
    });

    await adapter.publish(queueName, { attempt: "test" });

    await Promise.race([
      secondAttemptPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), 15_000)),
    ]);

    expect(attempts).toBeGreaterThanOrEqual(2);
    await adapter.unsubscribe(queueName);
  }, 20_000);

  it("createQueue with a deadLetterQueue routes a permanently-failing message to the DLQ after retryLimit is exhausted", async () => {
    const dlqName = `test-dlq-${randomUUID()}`;
    const mainQueueName = `test-main-${randomUUID()}`;
    await adapter.createQueue(dlqName);
    await adapter.createQueue(mainQueueName, {
      retryLimit: 1,
      deadLetterQueue: dlqName,
    });

    let resolveDeadLettered: () => void;
    const deadLetteredPromise = new Promise<void>((resolve) => {
      resolveDeadLettered = resolve;
    });

    await adapter.subscribe(dlqName, async (message) => {
      expect(message.payload).toEqual({ poison: true });
      resolveDeadLettered();
    });
    await adapter.subscribe(mainQueueName, async () => {
      throw new Error("this message always fails");
    });

    await adapter.publish(mainQueueName, { poison: true });

    await Promise.race([
      deadLetteredPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), 20_000)),
    ]);

    await adapter.unsubscribe(mainQueueName);
    await adapter.unsubscribe(dlqName);
  }, 25_000);

  it("AC-1803: a poison message being retried and dead-lettered does not block or delay a normal message on the same queue", async () => {
    const dlqName = `test-dlq-isolation-${randomUUID()}`;
    const mainQueueName = `test-main-isolation-${randomUUID()}`;
    await adapter.createQueue(dlqName);
    await adapter.createQueue(mainQueueName, {
      retryLimit: 1,
      retryDelaySeconds: 0,
      deadLetterQueue: dlqName,
    });

    let resolveDeadLettered: () => void;
    const deadLetteredPromise = new Promise<void>((resolve) => {
      resolveDeadLettered = resolve;
    });
    let resolveNormalProcessed: () => void;
    const normalProcessedPromise = new Promise<void>((resolve) => {
      resolveNormalProcessed = resolve;
    });

    await adapter.subscribe(dlqName, async (message) => {
      expect(message.payload).toEqual({ poison: true, id: "the-poison-message" });
      resolveDeadLettered();
    });
    await adapter.subscribe(mainQueueName, async (message) => {
      const payload = message.payload as { poison?: boolean; id: string };
      if (payload.poison) {
        throw new Error("this message always fails");
      }
      // A real normal message on the same queue, published alongside the
      // poison one — AC-1803's own "隔离性" claim: this must still be
      // consumed successfully, not starved or blocked by the poison
      // message's retries.
      expect(payload.id).toBe("the-normal-message");
      resolveNormalProcessed();
    });

    await adapter.publish(mainQueueName, { poison: true, id: "the-poison-message" });
    await adapter.publish(mainQueueName, { id: "the-normal-message" });

    await Promise.all([
      Promise.race([
        deadLetteredPromise,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("poison message never reached DLQ")), 20_000),
        ),
      ]),
      Promise.race([
        normalProcessedPromise,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("normal message was never consumed")), 20_000),
        ),
      ]),
    ]);

    await adapter.unsubscribe(mainQueueName);
    await adapter.unsubscribe(dlqName);
  }, 25_000);

  it("AC-1804: a message whose consumer never completes it (simulating a crashed Worker process) is failed and redelivered when the queue is told to stop non-gracefully", async () => {
    const queueName = `test-queue-crash-${randomUUID()}`;
    // `expireInSeconds` is still configured here as a real, independent
    // safety net for the scenario THIS test cannot itself exercise
    // in-process — a genuine `kill -9` that runs zero further JS,
    // including pg-boss's own cleanup (see the non-graceful-stop note
    // below). It is not what drives THIS test's own redelivery.
    await adapter.createQueue(queueName, { expireInSeconds: 2, retryLimit: 3 });
    await adapter.publish(queueName, { crash: true });

    // N4 real finding (P1, round 2): the original version subscribed the
    // permanently-hanging handler on the SUITE-SHARED `adapter` (the same
    // one every other test in this file, and this suite's own `afterAll`,
    // reuses) — a job whose handler never returns stays "active" from
    // pg-boss's own point of view, and `PgBoss#stop()`'s DEFAULT behavior
    // (`graceful: true`) waits up to its own 30-second timeout for active
    // work to finish before completing. `afterAll`'s `adapter.stop()`
    // would therefore hang for a mandatory 30s on every run — the exact
    // real CI-timeout risk this finding flagged. Fixed by using a
    // dedicated, THROWAWAY `PgBoss` instance (imported directly, not
    // through this package's own `QueueAdapter` wrapper — the wrapper's
    // own `stop()` has no way to request a non-graceful stop, and adding
    // one to the shared, cross-adapter `QueueAdapter` interface just for
    // this one test's cleanup would leak a Postgres-specific escape hatch
    // into a port SQS has no equivalent for) for JUST the "crashed
    // worker" side, stopped with `{ graceful: false }`.
    //
    // What this ACTUALLY exercises, precisely: pg-boss's own `stop({
    // graceful: false })` calls `failWip()` internally, which explicitly
    // fails every job this boss instance was actively holding — a real,
    // different (and, unlike a bare `expireInSeconds` timeout, immediate)
    // path to the SAME observable outcome AC-1804 cares about ("之前正在
    // 处理但未完成的消息被重新处理"). It is a closer match to a graceful-ish
    // shutdown sequence (SIGTERM, some code still runs) than to a true
    // `kill -9` (zero code runs, including this) — a genuine hard-crash
    // relies on `expireInSeconds` alone, which this specific in-process
    // test cannot deterministically wait out without either a slow test
    // or leaking a never-stopped boss instance's real Postgres connection
    // (the exact problem this fix removes). Both paths are real pg-boss
    // behavior this project genuinely relies on; this test proves one of
    // them precisely rather than overclaiming to prove both.
    const crashedBoss = new PgBoss(requireConnectionString());
    await crashedBoss.start();
    let receivedByCrashedWorker = false;
    await crashedBoss.work(queueName, { batchSize: 1 }, async () => {
      receivedByCrashedWorker = true;
      await new Promise(() => {
        // never resolves — the handler itself never gets the chance to
        // complete, same as a real crashed process's in-flight handler.
      });
    });

    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (receivedByCrashedWorker) {
              clearInterval(interval);
              resolve();
            }
          }, 20);
        }),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("crashed worker never received the message")), 10_000),
        ),
      ]);
    } finally {
      await crashedBoss.stop({ graceful: false });
    }

    // A FRESH adapter (simulating the restarted Worker process) picks up
    // and genuinely completes the SAME message once the expired job
    // becomes eligible for redelivery again.
    const restartedAdapter = createPostgresQueueAdapter(requireConnectionString());
    try {
      let resolveReprocessed: () => void;
      const reprocessedPromise = new Promise<void>((resolve) => {
        resolveReprocessed = resolve;
      });
      await restartedAdapter.subscribe(queueName, async (message) => {
        expect(message.payload).toEqual({ crash: true });
        resolveReprocessed();
      });

      await Promise.race([
        reprocessedPromise,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("message was never reprocessed after expiry")), 15_000),
        ),
      ]);
      await restartedAdapter.unsubscribe(queueName);
    } finally {
      await restartedAdapter.stop();
    }
  }, 30_000);
});
