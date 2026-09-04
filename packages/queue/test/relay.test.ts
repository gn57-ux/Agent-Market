import { describe, expect, it, vi } from "vitest";
import type { QueueAdapter } from "../src/adapter.js";
import type { ClaimedBatch } from "../src/relay.js";
import { relayPendingMessages } from "../src/relay.js";

function fakeQueue(overrides: Partial<QueueAdapter> = {}): QueueAdapter {
  return {
    createQueue: vi.fn(async () => {}),
    publish: vi.fn(async () => "msg-1"),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

/** A fake `ClaimedBatch` — no real locking (this is a pure unit test of
 * `relayPendingMessages`'s own dispatch logic, not of claim exclusivity;
 * the real claim/lock behavior is proven against a real Postgres database
 * in `apps/api/src/modules/outbox/relay.integration.test.ts`'s own
 * concurrent-relay test). `release` is tracked so tests can assert it's
 * always called exactly once, success or failure. */
function fakeBatch<T>(
  items: Array<{ id: string; payload: T }>,
  overrides: Partial<ClaimedBatch<T>> = {},
): ClaimedBatch<T> & { releaseCalls: number } {
  const batch = {
    items,
    markSent: vi.fn(async () => {}),
    release: vi.fn(async () => {
      batch.releaseCalls += 1;
    }),
    releaseCalls: 0,
    ...overrides,
  };
  return batch;
}

describe("relayPendingMessages", () => {
  it("publishes every pending item and marks each sent, then releases the batch", async () => {
    const batch = fakeBatch([
      { id: "a", payload: { foo: 1 } },
      { id: "b", payload: { foo: 2 } },
    ]);
    const publish = vi.fn(async (_queueName: string, envelope: unknown) => {
      return `msg-for-${(envelope as { id: string }).id}`;
    });
    const queue = fakeQueue({ publish });

    const result = await relayPendingMessages({
      source: { claimPending: async () => batch },
      queue,
      queueName: "test-queue",
    });

    expect(result.relayed).toBe(2);
    // T-1802: relayPendingMessages publishes an envelope carrying the
    // item's own id, not the bare payload — see relay.ts's own doc
    // comment on why business-level idempotency needs this.
    expect(publish).toHaveBeenCalledWith("test-queue", { id: "a", payload: { foo: 1 } });
    expect(publish).toHaveBeenCalledWith("test-queue", { id: "b", payload: { foo: 2 } });
    expect(batch.markSent).toHaveBeenCalledWith("a");
    expect(batch.markSent).toHaveBeenCalledWith("b");
    expect(batch.releaseCalls).toBe(1);
  });

  it("does nothing (but still releases) when the claimed batch is empty", async () => {
    const batch = fakeBatch<unknown>([]);
    const queue = fakeQueue();
    const result = await relayPendingMessages({
      source: { claimPending: async () => batch },
      queue,
      queueName: "test-queue",
    });
    expect(result.relayed).toBe(0);
    expect(queue.publish).not.toHaveBeenCalled();
    expect(batch.releaseCalls).toBe(1);
  });

  it("continues past a failing item, reports every failure via AggregateError, does not mark the failed item sent, and still releases the batch", async () => {
    const batch = fakeBatch([
      { id: "ok", payload: {} },
      { id: "broken", payload: {} },
    ]);
    const publish = vi.fn(async () => {
      // publish only sees the payload, not the item id — simulate failure
      // on the second call instead of keying off which item it was.
      if (publish.mock.calls.length === 2) throw new Error("publish failed");
      return "msg-ok";
    });
    const queue = fakeQueue({ publish });

    await expect(
      relayPendingMessages({
        source: { claimPending: async () => batch },
        queue,
        queueName: "test-queue",
      }),
    ).rejects.toThrow(AggregateError);

    expect(batch.markSent).toHaveBeenCalledWith("ok");
    expect(batch.markSent).not.toHaveBeenCalledWith("broken");
    expect(batch.releaseCalls).toBe(1);
  });
});
