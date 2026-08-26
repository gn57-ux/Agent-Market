-- Feature 9 (deliverable-submission), T-905, human review round B.
--
-- Replaces round A's abandoned `chain_events.block_number`-based
-- reorg-rollback design (that migration slot, 0010, is reused here — the
-- original 0010_add_chain_events_block_number.sql/.rollback.sql were
-- deleted before ever being committed). Round A's design was provably dead
-- code: `verifyResultSubmission` (tasks/service.ts) only ever writes a
-- `chain_events`/`RESULT_SUBMISSION` row AFTER its own internal
-- `confirmations >= resolveRequiredConfirmations()` check has already
-- passed, so a "roll back an unconfirmed chain_events projection" check
-- could never have anything to act on.
--
-- This table is the real fix (Option A of the two options compared in the
-- evidence packet — "pending event/projection", chosen over "provisional
-- SUBMITTED"): a genuinely separate holding area for a `ResultSubmitted`
-- log the poller has discovered but that has NOT yet reached the required
-- confirmation depth. `tasks.status` never moves off `ACCEPTED` because of
-- a row here — only once a row's block reaches
-- `resolveRequiredConfirmations()` does the poller call the
-- already-N4-reviewed `verifyResultSubmission` path to promote it for
-- real, exactly as today's HTTP-triggered/forward-scan-triggered call
-- already does. This keeps `tasks.status = 'SUBMITTED'` exactly as
-- trustworthy/final as every other status value in this schema always has
-- been (CLAUDE.md 原则 8 — illegal/half-final states should not be
-- representable in the primary entity), by isolating the "not yet final"
-- concept into its own dedicated table instead of overloading `tasks`.
--
-- `UNIQUE (chain_id, transaction_hash, log_index)` makes the forward scan's
-- insert naturally idempotent: this poller always re-scans its FULL block
-- range every tick (N4 round 2 P1) rather than tracking a cursor, so the
-- same already-pending log is rediscovered every tick — this constraint
-- (paired with the repository's `ON CONFLICT ... DO NOTHING`) turns that
-- rediscovery into a safe no-op instead of a duplicate row.
--
-- Round B originally also stored the decoded `result_hash`/
-- `submitted_at_onchain`/`review_deadline_onchain` here, but the promotion
-- pass never reads them — `verifyResultSubmission` always independently
-- re-fetches the receipt and re-decodes the event before trusting any of
-- those fields (this table is a lead to investigate, never the source of
-- truth). Dropped as unused rather than kept "for later" (human N4
-- follow-up, round B P2: CLAUDE.md 原则 4, no speculative fields).
CREATE TABLE pending_result_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  -- The block this log was discovered in — re-checked every tick against
  -- the RPC's current canonical block at that height via
  -- `event-sync.ts`'s `checkProjectionForReorg` (the one reorg rule this
  -- codebase uses; not a second, ad-hoc rule invented for this table).
  block_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  -- Passed as `verifyResultSubmission`'s `sessionAddress` on promotion —
  -- safe because `submitResult` (TaskEscrow.sol) already enforces
  -- `task.agent == msg.sender` on-chain (see result-submission-poller.ts's
  -- own doc comment for the full argument).
  agent_address TEXT NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pending_result_submissions_log_identity_unique
    UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE INDEX pending_result_submissions_chain_id_idx
  ON pending_result_submissions (chain_id);
