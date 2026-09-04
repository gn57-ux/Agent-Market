import type { MessageHandler } from "./adapter.js";

/**
 * F-1804 / AC-1802 (T-1802): "同一条消息被重复投递（至少一次语义的正常情况）
 * 不产生重复业务副作用". Deliberately a BUSINESS-level idempotency key, not
 * queue-native dedup (requirements.md's own text: "业务层面的幂等键，而非仅
 * 依赖队列本身的去重") — the queue-native message id is NOT a reliable
 * idempotency key for this system's real duplicate-delivery paths: a
 * relay claim (`claimPendingOutboxEvents`) that publishes successfully but
 * crashes before its transaction commits reverts the outbox row to
 * `PENDING`, and the next relay pass publishes it again as a genuinely
 * NEW queue message with a NEW queue-native id — same business event,
 * different message id. Only the outbox event's own stable `id` (`T-1800`'s
 * `writeOutboxEvent`'s own return value) survives that scenario, which is
 * why `relayPendingMessages` now publishes an `EventEnvelope` carrying
 * that id explicitly, instead of the bare business payload.
 */
export interface EventEnvelope<T = unknown> {
  id: string;
  payload: T;
}

export interface RunOnceResult<R> {
  alreadyProcessed: boolean;
  result?: R;
}

/**
 * A pluggable idempotency ledger. `runOnce` must atomically (a) check
 * whether `eventId` has already been processed by this ledger's consumer
 * and, if not, (b) record it as processed AND run `work` — both
 * committing or both rolling back together, so a `work` failure never
 * leaves a "processed" record behind for an event whose business effect
 * never actually happened (which would silently and permanently skip a
 * real retry). `TTx` is the transaction handle `work` receives, letting a
 * concrete implementation (e.g. `createPostgresIdempotencyLedger`) give
 * the handler the SAME transaction its own ledger insert used, so the
 * handler's own business writes commit or roll back atomically with the
 * ledger record — this package stays agnostic to what `TTx` actually is.
 */
export interface IdempotencyLedger<TTx = unknown> {
  runOnce<R>(eventId: string, work: (tx: TTx) => Promise<R>): Promise<RunOnceResult<R>>;
}

/**
 * Wraps a business handler with idempotent-consumption behavior, producing
 * a `MessageHandler<EventEnvelope<T>>` a `QueueAdapter.subscribe` can use
 * directly. `handler` only ever runs for an event this `ledger` hasn't
 * already recorded as processed — a genuine redelivery of the same
 * envelope (AC-1802's own test scenario) short-circuits before `handler`
 * is invoked at all, producing zero duplicate business side effects
 * without `handler` itself needing to know anything about idempotency.
 */
export function withIdempotentConsumption<T, TTx>(
  ledger: IdempotencyLedger<TTx>,
  handler: (payload: T, tx: TTx) => Promise<void>,
): MessageHandler<EventEnvelope<T>> {
  return async (message) => {
    await ledger.runOnce(message.payload.id, (tx) => handler(message.payload.payload, tx));
  };
}
