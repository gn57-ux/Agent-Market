/**
 * F-1802/F-1813 (Feature 18, T-1801): the one queue port both real
 * implementations (`postgres-adapter.ts`, `sqs-adapter.ts`) satisfy.
 *
 * Design comparison (CLAUDE.md 原则 3 — two directionally different
 * approaches, required before a new public interface): design.md's own
 * 决策 2 already compared three queue TECHNOLOGIES (Postgres/Redis/SQS) at
 * the infrastructure level and the user's v1.1 decision settled that to
 * "both Postgres locally and SQS in production, behind one interface" —
 * that choice is already made and is not re-litigated here. What this
 * module itself had to decide is narrower: how "outbox row becomes queue
 * message" is atomically guaranteed, given the two backends have
 * genuinely different atomicity guarantees available.
 *
 *   Option A — adapter-specific atomic enqueue: `publish()` accepts an
 *   optional caller-supplied DB transaction handle; the Postgres adapter
 *   (pg-boss genuinely supports this — `send(name, data, { db })`) inserts
 *   the queue row in the SAME transaction as the outbox write, skipping a
 *   separate relay process entirely for that one backend. Rejected: SQS
 *   has no equivalent — a `send` to SQS can never be part of a Postgres
 *   transaction, so this option would still need a second, different code
 *   path for SQS anyway, defeating "one consumer interface, two adapters"
 *   uniformity, and would leak a Postgres-specific capability
 *   (transaction handles) into a port meant to also describe a completely
 *   different backend (CLAUDE.md 原则 8).
 *
 *   Option B (chosen) — a poll-based relay (`relay.ts`), identical for
 *   both adapters: outbox rows are written durably first (T-1800, already
 *   its own committed transaction), and a separate relay step reads
 *   `PENDING` rows and calls this port's plain `publish()` — no
 *   transaction parameter anywhere on this interface. This is the
 *   textbook transactional-outbox relay shape, it is what a real SQS
 *   deployment needs regardless, and using the exact same relay code for
 *   the Postgres adapter too is what makes T-1801's own verification
 *   requirement possible in the first place ("一条 outbox 事件在两种适配器
 *   下均能被真实消费一次，行为一致（契约测试覆盖两个实现）") — a single
 *   relay/test harness exercising both adapters identically, rather than
 *   two different code paths that could silently drift apart.
 */
export interface QueueOptions {
  /** How many times a failed message is retried before moving to the dead
   * letter queue. `undefined` defers to the adapter's own default. */
  retryLimit?: number;
  /** Name of the queue failed messages move to once `retryLimit` is
   * exhausted (F-1805 poison-message handling). `undefined` means no DLQ
   * is configured for this queue — a genuine, valid choice for a queue
   * whose messages are all safe to retry indefinitely, but the adapter
   * must not silently invent one. */
  deadLetterQueue?: string;
  /**
   * F-1803 (T-1803): the "退避重试策略" (backoff retry policy) config knob
   * — how long, in seconds, a failed message stays invisible/unavailable
   * before it becomes eligible for retry again. `undefined` defers to the
   * adapter's own default. The two adapters implement this with genuinely
   * different native mechanisms (pg-boss: a literal fixed `retryDelay`
   * between attempts; SQS: the queue's `VisibilityTimeout`, which governs
   * how long ANY received-but-not-yet-deleted message — first attempt or
   * retry — stays invisible before becoming visible for redelivery) —
   * this option is deliberately the one place those two real mechanisms
   * are asked to produce the SAME observable behavior (a message that
   * just failed doesn't become immediately re-deliverable), not a
   * guarantee that the two adapters implement identical internal timing
   * semantics beyond that.
   */
  retryDelaySeconds?: number;
  /**
   * F-1806 / AC-1804 (T-1804): how long, in seconds, a message may sit
   * "in progress" (received by a consumer that never called back with
   * success or failure — most concretely, a Worker process that crashes
   * or is killed mid-handler) before the queue gives up waiting and makes
   * it eligible for redelivery again. `undefined` defers to the adapter's
   * own default (pg-boss: 15 minutes). This is deliberately a SEPARATE
   * concept from `retryDelaySeconds` (which only applies after an
   * explicit handler failure — a thrown error, which a dead process can
   * never produce): a killed worker never gets the chance to call
   * `ChangeMessageVisibilityCommand`/fail the pg-boss job itself, so only
   * this "how long do I wait for a heartbeat before assuming the worker
   * is gone" timeout governs recovery in that scenario.
   *
   * pg-boss has a direct, literal match (`expireInSeconds`). SQS has no
   * separate concept — its own `VisibilityTimeout` (already covered by
   * `retryDelaySeconds` on that adapter) already serves exactly this
   * purpose too: a message becomes redeliverable once its visibility
   * window elapses, regardless of whether that's because a handler threw
   * or because the receiving process simply died. The SQS adapter
   * therefore does not read this option — setting `retryDelaySeconds`
   * already covers the equivalent SQS behavior for both scenarios.
   */
  expireInSeconds?: number;
}

export interface QueueMessage<T = unknown> {
  /** Adapter-native message identity (pg-boss job id / SQS message id) —
   * opaque to callers, only used for `ack`/`nack`. */
  id: string;
  payload: T;
}

/**
 * A consumer handler processes one message and returns normally to
 * acknowledge it (removed from the queue / marked complete), or throws to
 * signal failure (the adapter re-queues per `QueueOptions.retryLimit`,
 * eventually moving it to `deadLetterQueue` if configured — F-1803).
 * Deliberately return-value-free rather than an explicit ack/nack object:
 * "did the handler complete without throwing" is the one signal every
 * queue technology already has a native representation for, so this
 * doesn't invent a second, adapter-specific acknowledgment protocol
 * on top (CLAUDE.md 原则 7 — complexity that belongs in the adapter stays
 * in the adapter, not pushed onto every handler).
 */
export type MessageHandler<T = unknown> = (message: QueueMessage<T>) => Promise<void>;

export interface QueueAdapter {
  /** Idempotent: safe to call for a queue that already exists. */
  createQueue(name: string, options?: QueueOptions): Promise<void>;
  /** Enqueues one message, returning the adapter-native message id. */
  publish(queueName: string, payload: unknown): Promise<string>;
  /** Starts consuming `queueName` with `handler`. Resolves once the
   * consumer is actively polling/listening — does not block for the
   * queue's lifetime (callers that need "run forever" wrap this in their
   * own process entry point, same as `apps/indexer/src/main.ts`'s own
   * polling loop). */
  subscribe<T = unknown>(queueName: string, handler: MessageHandler<T>): Promise<void>;
  unsubscribe(queueName: string): Promise<void>;
  /** Releases any held connections/handles. */
  stop(): Promise<void>;
}
