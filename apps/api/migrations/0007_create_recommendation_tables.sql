-- Feature 7 (dispatch-matching), T-705.
-- recommendation_runs / recommendation_candidates persist the result of one
-- `POST /tasks/:taskId/match` call: one run row per invocation, one
-- candidate row per slot the Go dispatch service actually recommended
-- (never the full candidate pool sent to it — see T-705 capsule's
-- "candidate_count 用发给 Go 的候选总数，不是返回的推荐数" note: that total is
-- recorded on the run row itself, not by counting these child rows).
-- Additive-only against 0001-0006 — none of those files are edited in
-- place, matching this project's established migration convention.
-- `sequence_no` is a monotonic tiebreaker for "which run is latest" —
-- `requested_at` (TIMESTAMPTZ) is not a uniqueness guarantee, and two
-- `POST /tasks/:taskId/match` calls landing in the same DB-clock instant
-- would otherwise make `ORDER BY requested_at DESC LIMIT 1` pick either row
-- nondeterministically (Codex review, T-706 round 1, P2). `id` (UUID v4) is
-- not sortable-by-creation-order, so it can't serve this role.
CREATE TABLE recommendation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_no BIGSERIAL NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0)
);

CREATE INDEX recommendation_runs_task_id_idx ON recommendation_runs (task_id);

-- `agent_id` references `agents(id)` with no `ON DELETE CASCADE` —
-- deliberately, mirroring 0006_add_dispatch_matching_fields.sql's
-- `tasks.accepted_agent_id` decision: Agent one-period never hard-deletes a
-- row (deactivation is a status flip, F-504), so this table never needs to
-- react to an Agent disappearing out from under a past recommendation
-- record.
CREATE TABLE recommendation_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES recommendation_runs (id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents (id),
  rank INTEGER NOT NULL CHECK (rank >= 1),
  slot_type TEXT NOT NULL CHECK (slot_type IN ('TOP_SCORE', 'EXPLORATION')),
  score NUMERIC NOT NULL,
  reasons JSONB NOT NULL
);

CREATE INDEX recommendation_candidates_run_id_idx ON recommendation_candidates (run_id);
