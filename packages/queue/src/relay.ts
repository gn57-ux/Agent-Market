import type { QueueAdapter } from "./adapter.js";

/**
 * The relay side of the transactional outbox pattern (F-1801's own second
 * half, T-1801's own scope: "建立发布（outbox → 队列）与消费的最小闭环") —
 * deliberately schema-agnostic (CLAUDE.md 原则 6): this module has zero
 * knowledge of `outbox_events`'s columns or any specific business event
 * shape. `apps/api`'s own outbox module (`claimPendingOutboxEvents`) is
 * the single owner of that schema and supplies this function with a small
 * `ClaimedBatch` instead. This keeps `packages/queue` reusable for a
 * future outbox-shaped table this project hasn't built yet, without ever
 * needing to change.
 *
 * N4 real finding (P1, round 1): the original version of this file had a
 * plain `fetchPending()`/`markSent(id)` pair with NO exclusivity
 * mechanism — two relay instances calling `fetchPending()` concurrently
 * (or a horizontally-scaled relay/worker deployment, which F-1806 itself
 * anticipates) would both read the SAME still-`PENDING` rows and both
 * publish them, producing real duplicate deliveries this Task's own AC
 * ("消费一次") did not actually hold under that condition.
 *
 * Fixed by requiring the source to CLAIM a batch atomically — the
 * concrete Postgres implementation (`claimPendingOutboxEvents`) does this
 * with `SELECT ... FOR UPDATE SKIP LOCKED` inside an open transaction: a
 * second, concurrent claim call skips every row the first transaction is
 * still holding, so two relay instances can never process the same row.
 * This closes the "concurrent relay" duplication scenario completely.
 *
 * It does NOT (and cannot, without full two-phase commit across two
 * independent systems — Postgres and the queue backend) close a
 * DIFFERENT scenario: `queue.publish()` succeeds, and then the process
 * crashes before `batch.release()` commits the claim. On restart, the
 * held transaction is gone (rolled back), the row is still `PENDING`, and
 * the next relay run publishes it again — a genuine duplicate delivery.
 * This is the same "at-least-once, not exactly-once" gap F-1804's own
 * requirement text already names as expected and normal ("同一条消息被
 * 重复投递...正常情况"), whose stated mitigation is consumer-side
 * idempotency — T-1802's own separate, explicit scope (CLAUDE.md 原则 9),
 * not something a relay alone can or should try to solve.
 */
export interface ClaimedBatch<T = unknown> {
  items: Array<{ id: string; payload: T }>;
  /** Marks one claimed item sent. Must be called on the SAME underlying
   * connection/transaction `claimPending` used to claim the batch, so the
   * write only becomes visible to other callers once `release()` commits
   * — see `apps/api`'s `claimPendingOutboxEvents` for the concrete
   * implementation this requires. */
  markSent(id: string): Promise<void>;
  /** Commits any `markSent` calls and releases the claim (and, for the
   * Postgres implementation, the row locks). Always called exactly once,
   * whether the batch succeeded or failed — a batch that failed midway
   * still needs its successfully-sent items committed and its remaining
   * claimed-but-unsent rows released back to `PENDING` for the next run. */
  release(): Promise<void>;
}

export interface RelaySource<T = unknown> {
  claimPending(limit: number): Promise<ClaimedBatch<T>>;
}

export interface RelayResult {
  relayed: number;
}

/**
 * Claims up to `limit` pending rows, publishes each to `queueName` via
 * `queue`, and marks it sent — all within the one claim `release()`
 * eventually commits. One row's publish failing does not abort the rest
 * of the batch — the failure is thrown to the caller only after every
 * other row in the batch has been attempted (surfaced via
 * `AggregateError` when any row failed); the batch is always released
 * (`finally`), regardless of outcome, so a partial failure still commits
 * whatever did succeed and releases the rest back to `PENDING`.
 *
 * AC-1801's own text ("重启后未发送的 outbox 记录仍然存在且会被重新发送") is
 * exactly what calling this function again after a crash achieves: a row
 * that was written (T-1800's atomic transaction) but never reached
 * `markSent`+`release()` is still `PENDING`, so the next
 * `relayPendingMessages` call picks it up again — no separate "resume
 * from where I crashed" state is needed beyond the outbox table's own
 * `status` column.
 */
export async function relayPendingMessages<T = unknown>(params: {
  source: RelaySource<T>;
  queue: QueueAdapter;
  queueName: string;
  limit?: number;
}): Promise<RelayResult> {
  const batch = await params.source.claimPending(params.limit ?? 100);
  const errors: unknown[] = [];
  let relayed = 0;

  try {
    for (const item of batch.items) {
      try {
        // T-1802's own real requirement (AC-1802, "业务层面的幂等键，而非
        // 仅依赖队列本身的去重"): the published message carries the
        // event's own stable id (`item.id`), not just its bare business
        // payload — see `idempotent-consumer.ts`'s `EventEnvelope` doc
        // comment for why the queue-native message id alone can't serve
        // as that key (a relay crash between a successful publish and
        // `release()` republishes the SAME event as a genuinely NEW queue
        // message with a NEW native id).
        await params.queue.publish(params.queueName, { id: item.id, payload: item.payload });
        await batch.markSent(item.id);
        relayed += 1;
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    await batch.release();
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `relayPendingMessages: ${errors.length} row(s) failed`);
  }

  return { relayed };
}
