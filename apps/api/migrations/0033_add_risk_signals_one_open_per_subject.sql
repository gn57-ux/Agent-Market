-- Feature 20 (agent-evaluation-appeal-antifraud), T-2005.
--
-- N4 real finding (P2): a detector job (e.g. detect-score-manipulation.ts)
-- is meant to be re-run repeatedly, and two overlapping runs (a slow run
-- plus an overlapping scheduled one, or a manual + scheduled run at the
-- same time) could both check "does an open signal already exist for this
-- (signal_type, subject_agent_id)" before either has committed its own
-- INSERT, both observe "no", and both insert — a real TOCTOU race with no
-- database constraint stopping it. Same pattern this codebase already uses
-- twice (`disputes_task_id_unique_open`, `evaluation_appeals_one_pending_
-- per_result`): a partial unique index makes "at most one open signal per
-- (signal_type, subject_agent_id)" a real guarantee, not just an
-- application-level check-then-insert.
--
-- Scoped to `subject_agent_id IS NOT NULL` — every detector today
-- (T-2005; T-2006/T-2007 to follow) always sets `subject_agent_id`, never
-- `subject_address` alone; this index does not need to (and does not)
-- cover the `subject_address`-only case since no writer produces it yet.
CREATE UNIQUE INDEX risk_signals_one_open_per_agent_and_type
  ON risk_signals (signal_type, subject_agent_id)
  WHERE status IN ('DETECTED', 'UNDER_REVIEW') AND subject_agent_id IS NOT NULL;
