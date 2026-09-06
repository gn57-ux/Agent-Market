-- Feature 20 (agent-evaluation-appeal-antifraud), T-2009, design.md 决策 3.
--
-- F-2012's own hard boundary: this column is a single enum "放行/不放行"
-- signal, never a score. Go's `eligibility.Filter` (services/dispatch)
-- reads `baseline_evaluation_status == 'PASSED'` as one more in-memory AND
-- condition alongside its existing seven — it has no database connection
-- of its own, so this is the ONLY channel through which "has this Agent
-- cleared the basic evaluation gate" reaches dispatch, and it carries no
-- score/rubric/dimension detail (F-2011's boundary made structural).
--
-- Historical rows default `NOT_STARTED` — the same conservative default
-- Feature 16's own review-status migration used: never assume an existing
-- Agent already cleared a gate that didn't exist when it was created.
ALTER TABLE agents
  ADD COLUMN baseline_evaluation_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (baseline_evaluation_status IN ('NOT_STARTED', 'PENDING', 'PASSED', 'FAILED'));
