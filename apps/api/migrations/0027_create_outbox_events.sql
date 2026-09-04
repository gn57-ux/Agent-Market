-- Feature 18 (outbox-queue-chain-indexer), T-1800.
--
-- F-1801 "Transactional outbox": design.md's own data model, implemented
-- verbatim. `status` starts at 'PENDING' — this migration only creates the
-- table a caller's own business-write transaction inserts into; nothing in
-- this Feature's T-1800 scope ever transitions a row to 'SENT'/'FAILED'
-- (that is T-1801's publisher/relay, a separate Task, separate Task
-- Capsule, separate N4 review — CLAUDE.md 原则 9 "增加功能和重构必须分开"
-- applies equally to "功能拆分成独立可验证切片" here: this migration's own
-- job is done once the table exists and one function can insert into it
-- atomically with a caller's business write).
--
-- `aggregate_type`/`aggregate_id`/`event_type` are free TEXT/UUID, not a
-- closed enum — same "purpose is free TEXT, not a DB-level enum" reasoning
-- `chain_transactions.purpose` (0005_create_tasks.sql) already established
-- in this codebase: the set of real (aggregate_type, event_type) pairs
-- will grow as real consumers (Feature 17's DAG node advancement, Feature
-- 19's event pipeline) are wired up in later Tasks, and a DB CHECK
-- constraint would need a migration for every new one — the actual
-- validation belongs to whichever caller constructs a `writeOutboxEvent`
-- call (a TypeScript union type at that call site), not to this table.
--
-- Deliberately no `IF NOT EXISTS` (see 0001_create_users.sql's header
-- comment for the rationale this repo's own migrations already follow).
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

-- T-1801's publisher will repeatedly scan for `status = 'PENDING'` rows in
-- creation order — an index on exactly that predicate now, rather than
-- waiting for T-1801 to discover the need under a real (if small in this
-- project's real traffic) table scan.
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at) WHERE status = 'PENDING';
