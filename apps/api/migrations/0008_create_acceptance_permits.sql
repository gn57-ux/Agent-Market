-- Feature 8 (task-acceptance), T-801. Edited in place by T-806 (human N6
-- BLOCK fix, round after T-803/T-805): this migration has never been
-- committed/merged, so per the capsule's explicit instruction it is
-- rewritten directly rather than adding a 0009 patch migration.
--
-- Feature 7 (T-706) deliberately deferred creating this table (dispatch/
-- routes.ts's `issuePermitsForTask` doc comment: "no acceptance_permits
-- table exists yet ... this Task only signs and returns") — this migration
-- is Feature 8 building it, per the capsule's explicitly confirmed scope
-- decision. Additive-only against 0001-0007 — none of those files are
-- edited in place, matching this project's established migration
-- convention (0006/0007's own header comments).
--
-- Field list is specs/07-dispatch-matching/design.md's "数据模型" section,
-- verbatim: `taskId, agentId, nonce, expiry, chainId, verifyingContract,
-- signature, consumedAt`. `id`/`created_at` are added here as this table's
-- own primary key and insertion-order tiebreaker (mirroring
-- 0007_create_recommendation_tables.sql's `recommendation_runs` shape) —
-- neither is part of design.md's field list, both are this migration's own
-- implementation detail for the primary key.
--
-- `nonce` is a `uint256` on-chain (contracts/src/TaskEscrow.sol's
-- `AcceptancePermit.nonce`) — TEXT, not NUMERIC/BIGINT, storing the exact
-- decimal string `permit.service.ts`'s `IssuedAcceptancePermit.nonce`
-- already serializes via `.toString()` (a JS `bigint`), matching
-- `tasks.budget`'s own "never touch a uint256-range value as a JS number"
-- precedent (tasks/schema.ts's BUDGET_SCHEMA comment) rather than risking
-- precision loss through a numeric column type. `expiry`/`chain_id` stay
-- plain integer columns: both are always small (Unix-seconds expiry,
-- EVM chain id), well inside BIGINT/INTEGER range, exactly mirroring
-- `IssuedAcceptancePermit.expiry`/`chainId`'s own JS `number` types.
--
-- `signature`/`nonce`/`accepting_address` must never be logged (T-801/T-806
-- capsule's explicit constraint) — this migration only defines storage,
-- callers (dispatch/repository.ts) are responsible for never including
-- these columns in any log statement.
--
-- T-806 (human N6 BLOCK fix): T-803 round 2 previously "fixed" the
-- same-wallet-multiple-Agents ambiguity by deduping permit issuance down to
-- one permit per WALLET (skipping lower-ranked candidates). The human
-- reviewer rejected that — every recommended candidate must get its own
-- permit, and attribution back to which Agent actually accepted must be
-- exact (decoded on-chain nonce), not guessed. Two columns below exist
-- specifically to make that possible:
--   - `accepting_address`: the candidate wallet snapshot AT ISSUANCE TIME
--     (the value actually signed into the EIP-712 message and written into
--     the on-chain `AcceptancePermit.agent` field) — deliberately NOT
--     re-derived from `agents.owner_address` at read time, since that
--     column could in principle be edited after issuance; this column
--     records what was actually true when the permit was signed.
--   - `status`: replaces the old NULL/non-NULL `consumed_at` judgment with
--     an explicit enum (CLAUDE.md 原则 8: 让非法状态无法表示) — OUTSTANDING
--     (usable), CONSUMED (this exact permit's nonce was the one used
--     on-chain), INVALIDATED (a different candidate's permit won, OR (see
--     Feature 7 sync note below) this task's current recommendation round
--     was superseded — this row can never be used again). IMPORTANT:
--     INVALIDATED is bookkeeping only — it has no on-chain enforcement
--     weight whatsoever. TaskEscrow.acceptTask never reads this table, so
--     marking a row INVALIDATED does not revoke the EIP-712 signature
--     already handed to that candidate; the signature stays cryptographically
--     usable until its own `expiry` passes. The real security invariant
--     ("at most 3 candidates hold a valid permit at a time") is enforced by
--     `hasUnexpiredOutstandingPermits`/round-gating in repository.ts, which
--     refuses to start a new recommendation round while the current round
--     still has any unexpired OUTSTANDING permit — never by this status
--     column. Do not treat INVALIDATED as a revocation guarantee anywhere
--     in this codebase's comments or API responses.
--
-- Feature 7 sync (T-708/T-709 human-supplemental-review fixes, merged onto
-- this branch after both Features' independent N6 rounds): adds `run_id`
-- (below) — a permit belongs to one specific recommendation run's candidate
-- list, not loosely to the task. This is additive to, not a replacement
-- for, the exact-nonce-attribution design above: `run_id` lets
-- round-gating queries find "this task's current round" without scanning
-- by timestamp, while `(task_id, agent_id, nonce)` stays the uniqueness/
-- attribution key T-806 established. `recommendation_runs.input_digest`
-- (bottom of this file) is also part of this sync.
CREATE TABLE acceptance_permits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  -- The recommendation run this permit was issued for (Feature 7 sync,
  -- T-709). Required — every permit issuance is always in response to a
  -- specific run's candidate list (dispatch/routes.ts's issuePermitsForTask
  -- always reads a run's candidates before signing), so there is never a
  -- legitimate permit with no owning run. Used by hasUnexpiredOutstandingPermits/
  -- getLatestRecommendationRunId-style round-gating queries, NOT by the
  -- exact-attribution lookup (which stays keyed on accepting_address+nonce,
  -- per T-806 — see acceptance_permits_task_address_nonce_idx below).
  run_id UUID NOT NULL REFERENCES recommendation_runs (id) ON DELETE CASCADE,
  -- No `ON DELETE CASCADE` from agents — mirrors 0006/0007's
  -- `accepted_agent_id`/`recommendation_candidates.agent_id` precedent:
  -- Agent one-period never hard-deletes a row, so this table never needs to
  -- react to an Agent disappearing out from under a past permit record.
  agent_id UUID NOT NULL REFERENCES agents (id),
  -- The candidate wallet snapshot at issuance time — see this file's header
  -- comment. Normalized to lowercase before insertion (dispatch/
  -- repository.ts), matching every other stored address column's
  -- convention (e.g. `agents.owner_address`).
  accepting_address TEXT NOT NULL CHECK (accepting_address ~ '^0x[0-9a-f]{40}$'),
  nonce TEXT NOT NULL,
  expiry BIGINT NOT NULL,
  chain_id INTEGER NOT NULL,
  verifying_contract TEXT NOT NULL CHECK (verifying_contract ~ '^0x[0-9a-f]{40}$'),
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OUTSTANDING'
    CHECK (status IN ('OUTSTANDING', 'CONSUMED', 'INVALIDATED')),
  -- Timestamp of the status change away from OUTSTANDING (CONSUMED or
  -- INVALIDATED) — NULL while still OUTSTANDING. Semantics shifted from
  -- "is this consumed" (T-801) to "when did this row's status last change"
  -- (T-806); the column name is kept (no call site needs to change its
  -- name, only how it's set).
  consumed_at TIMESTAMPTZ NULL,
  -- The on-chain transaction hash that actually consumed this permit — only
  -- ever set together with `status = 'CONSUMED'`. Rows that become
  -- INVALIDATED were never consumed BY a transaction (they just stopped
  -- being usable because a different candidate's permit won), so this stays
  -- NULL for them.
  consumed_tx_hash TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Prevents re-inserting the exact same issuance twice; does NOT limit an
  -- agent to one row overall — the same Agent can legitimately hold several
  -- permit rows across different `/match` runs, each with its own nonce.
  UNIQUE (task_id, agent_id, nonce)
);

-- Matches the real query shape both `issuePermitsForTask`'s backfill and
-- `getPermitForAgent`'s permit-scoped lookup run: "every permit row for this
-- (task, agent) pair."
CREATE INDEX acceptance_permits_task_agent_idx ON acceptance_permits (task_id, agent_id);

-- Feature 7 sync (T-709): round-gating queries (hasUnexpiredOutstandingPermits,
-- getOutstandingPermitsForRun-style lookups) filter by run_id directly.
CREATE INDEX acceptance_permits_run_id_idx ON acceptance_permits (run_id);

-- `resolveAcceptingAgentId`'s exact-match lookup key (T-806): given the
-- on-chain event's accepting wallet and the calldata-decoded nonce, find the
-- one permit row that was actually used.
CREATE INDEX acceptance_permits_task_address_nonce_idx
  ON acceptance_permits (task_id, accepting_address, nonce);

-- Feature 7 sync (T-709, P2): SHA-256 (hex) of the canonically-ordered JSON
-- serialization of the MatchRequest sent to the Go dispatch service for
-- that run, computed in dispatch/routes.ts via Node's built-in crypto
-- module (no new dependency) — see dispatch/input-digest.ts. Lets a human
-- confirm exactly what was sent for a given run without needing to retain
-- the full request body. Added with a transitional DEFAULT so any row that
-- predates this column does not fail the ALTER; the DEFAULT is then
-- dropped so every future INSERT must supply a real digest explicitly.
ALTER TABLE recommendation_runs ADD COLUMN input_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE recommendation_runs ALTER COLUMN input_digest DROP DEFAULT;
