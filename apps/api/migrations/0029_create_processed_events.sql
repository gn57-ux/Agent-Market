-- Feature 18 (outbox-queue-chain-indexer), T-1802.
--
-- F-1804 "幂等/顺序/并发处理", AC-1802: a business-level idempotency
-- ledger, deliberately NOT relying on queue-native deduplication alone
-- (requirements.md's own text: "业务层面的幂等键，而非仅依赖队列本身的去重")
-- — neither adapter's native dedup covers every real duplicate-delivery
-- path this system has: `outbox_events`' own relay can legitimately
-- publish the SAME event twice as two genuinely separate queue sends (a
-- relay claim that publishes successfully but crashes before its
-- transaction commits — see `claimPendingOutboxEvents`'s own doc comment
-- — reverts the row to `PENDING` and a later relay pass sends it again as
-- a brand-new message with a brand-new queue-native message id). Only the
-- outbox event's own stable `id` survives that scenario, so that id
-- (carried in the published message's own envelope, not the queue's
-- native message id) is this ledger's key.
--
-- `consumer_name` scopes the ledger per logical consumer rather than
-- globally per event — a real, anticipated future need: the same outbox
-- event may eventually need independent processing by more than one
-- consumer (Feature 17's DAG node advancement and a later Feature 19
-- event-collection consumer, per this Feature's own requirements.md
-- "现有实现基线" section), and one consumer's processing must not block
-- or skip another's.
--
-- Deliberately no `IF NOT EXISTS` (see 0001_create_users.sql's header
-- comment for the rationale this repo's own migrations already follow).
CREATE TABLE processed_events (
  consumer_name TEXT NOT NULL,
  event_id UUID NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);
