-- Feature 18 (outbox-queue-chain-indexer), T-1805.
--
-- F-1807 "独立链事件索引服务": design.md's own data model, with one real
-- correctness fix on top (N4 review, real P2): design.md's own SQL sketch
-- wrote `chain_id INTEGER`, but `packages/domain/src/chain-config.ts`'s own
-- `CHAIN_ID` validation only requires a positive JS safe integer — it does
-- NOT cap it to PostgreSQL `INTEGER`'s signed 32-bit range (max
-- ~2.1 billion). A real, valid configured chain id above that range (e.g.
-- some real L2/rollup chain ids already do) would make every write to this
-- table fail with "integer out of range", silently breaking indexing for
-- that chain entirely. `chain_id BIGINT` matches the wider range this
-- project's own domain validation already promises, and matches
-- `chain_transactions`/`chain_events` (0005_create_tasks.sql), which
-- already use `BIGINT chain_id` for the identical concept — this migration
-- had drifted from that existing convention, not established a new one.
--
-- `chain_id`/`tx_hash`/`log_index` together are the natural,
-- chain-native identity of one event log — `UNIQUE (chain_id, tx_hash,
-- log_index)` is what makes a re-scan of an already-indexed block range
-- (T-1806's breakpoint resume, or simple operator error) idempotent via
-- `ON CONFLICT DO NOTHING` at the write site, rather than requiring the
-- indexer to track "have I seen this log before" itself.
--
-- `event_type`/`decoded_payload` follow the same "free TEXT + JSONB, not a
-- closed DB enum per event" reasoning as `outbox_events.event_type`
-- (0027_create_outbox_events.sql) and `chain_transactions.purpose`
-- (0005_create_tasks.sql): the set of real `TaskEscrow` event types is
-- validated once, at the single place that decodes a raw log into one of
-- them (`packages/domain/src/chain-events/*.ts`), not duplicated as a DB
-- CHECK constraint that would need a migration for every future event
-- added to the contract.
--
-- `confirmation_status` starts at its schema default `PENDING_CONFIRMATION`
-- for every row this Task's own scanner writes — T-1805's scope is the
-- scan-and-write skeleton only; the two-state confirmation-depth logic
-- that actually promotes a row to `CONFIRMED` (and the reorg rollback that
-- deletes/rewrites rows still in the pending window) is T-1806/T-1807's
-- own separate scope (CLAUDE.md 原则 9), not implemented here.
--
-- Deliberately no `IF NOT EXISTS` (see 0001_create_users.sql's header
-- comment for the rationale this repo's own migrations already follow).
CREATE TABLE chain_indexed_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id BIGINT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  decoded_payload JSONB NOT NULL,
  confirmation_status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION'
    CHECK (confirmation_status IN ('PENDING_CONFIRMATION', 'CONFIRMED')),
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index)
);

-- T-1806's breakpoint-resume scan ("从上次确认高度继续") will repeatedly
-- need "what is the highest indexed block for this chain" — an index on
-- exactly that predicate now, same anticipatory-but-evidence-based
-- reasoning `outbox_events_pending_idx` already used for its own known
-- future consumer.
CREATE INDEX chain_indexed_events_block_number_idx ON chain_indexed_events (chain_id, block_number);
