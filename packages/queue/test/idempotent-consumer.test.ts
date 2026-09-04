import { describe, expect, it, vi } from "vitest";
import type { IdempotencyLedger } from "../src/idempotent-consumer.js";
import { withIdempotentConsumption } from "../src/idempotent-consumer.js";

/** A fake in-memory ledger — proves `withIdempotentConsumption`'s own
 * dispatch logic (call `runOnce` with the envelope's own id, only invoke
 * `handler` when not already processed). The real atomic
 * check-and-record-together behavior is proven against a real Postgres
 * database in `postgres-idempotency-ledger.integration.test.ts`. */
function fakeLedger(): IdempotencyLedger<undefined> & { processed: Set<string> } {
  const processed = new Set<string>();
  return {
    processed,
    async runOnce(eventId, work) {
      if (processed.has(eventId)) {
        return { alreadyProcessed: true };
      }
      processed.add(eventId);
      const result = await work(undefined);
      return { alreadyProcessed: false, result };
    },
  };
}

describe("withIdempotentConsumption", () => {
  it("runs the handler once for a fresh event id", async () => {
    const ledger = fakeLedger();
    const handler = vi.fn(async () => {});
    const wrapped = withIdempotentConsumption(ledger, handler);

    await wrapped({ id: "msg-1", payload: { id: "event-1", payload: { note: "hello" } } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ note: "hello" }, undefined);
  });

  it("AC-1802: redelivering the SAME event id does not run the handler a second time", async () => {
    const ledger = fakeLedger();
    const handler = vi.fn(async () => {});
    const wrapped = withIdempotentConsumption(ledger, handler);

    const envelope = { id: "msg-1", payload: { id: "event-1", payload: { note: "hello" } } };
    await wrapped(envelope);
    await wrapped(envelope); // simulated redelivery of the exact same message

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("two DIFFERENT event ids each run the handler once — the ledger scopes by event id, not by any shared state", async () => {
    const ledger = fakeLedger();
    const handler = vi.fn(async () => {});
    const wrapped = withIdempotentConsumption(ledger, handler);

    await wrapped({ id: "msg-1", payload: { id: "event-1", payload: { note: "a" } } });
    await wrapped({ id: "msg-2", payload: { id: "event-2", payload: { note: "b" } } });

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
