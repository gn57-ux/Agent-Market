-- Feature 18 (outbox-queue-chain-indexer), T-1806 round 2 (N4 real P1 fix).
--
-- Round 1's restart-resume logic only ever fell back to
-- `findLastConfirmedBlockNumber()` (deliberately CONFIRMED-only, per that
-- function's own doc comment, for T-1807's reorg-safety reasoning) or, if
-- nothing has ever been confirmed yet, straight to
-- `INDEXER_START_BLOCK`/the current chain tip. Codex review (round 1,
-- real P1) caught the real gap this produces: a process that restarts
-- BEFORE its first indexed event reaches `confirmationDepth` has
-- `lastConfirmed = null`, so it jumps straight to the tip — permanently
-- skipping every block already scanned in the previous run AND every
-- block mined during the downtime before the new tip, neither of which
-- ever gets scanned.
--
-- This table is a separate, raw "how far has this chain actually been
-- scanned" checkpoint, deliberately independent of confirmation state —
-- it is updated every poll tick a scan actually ran (`main.ts`), even for
-- a block range with zero matching events, which `chain_indexed_events`
-- alone cannot answer (an empty range leaves no row there at all). On
-- restart, `main.ts` resumes from the SMALLER of
-- `last_scanned_block + 1` and `findLastConfirmedBlockNumber() + 1`
-- (falling back to whichever of the two actually exists) — this never
-- regresses the existing CONFIRMED-only reorg-safety behavior (a
-- confirmed row is by definition already scanned, so
-- `lastConfirmed + 1 <= last_scanned_block + 1` always holds when both
-- exist) while also closing the "never confirmed anything yet" gap this
-- migration exists to fix.
--
-- One row per chain — `chain_id PRIMARY KEY`, matching
-- `chain_indexed_events.chain_id`'s own `BIGINT` type/range reasoning
-- (0028_create_chain_indexed_events.sql's own header comment).
--
-- Deliberately no `IF NOT EXISTS` (see 0001_create_users.sql's header
-- comment for the rationale this repo's own migrations already follow).
CREATE TABLE indexer_scan_checkpoints (
  chain_id BIGINT PRIMARY KEY,
  last_scanned_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
