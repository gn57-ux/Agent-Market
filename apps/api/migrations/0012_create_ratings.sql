-- Feature 10 (review-timeout-dispute), T-1003.
--
-- `ratings`: one row per `POST /tasks/:taskId/ratings` submission
-- (F-1005). `UNIQUE (task_id)` is the table's own idempotency boundary —
-- "同一任务只能提交一次" (requirements.md AC-1004) — a plain unique
-- constraint (not a partial index like `disputes_task_id_unique_open`)
-- because a rating, once submitted, is never resolved/reopened the way a
-- dispute is; there is no legitimate "second row" state to distinguish.
--
-- `score` is the raw 1-5 rating a requester gives (design.md's interface
-- contract: `score: 1|2|3|4|5`) — NOT the same scale as
-- `agents.quality_score` (0004_create_agents.sql's `CHECK (quality_score
-- BETWEEN 0 AND 1)`, consumed directly by services/dispatch's Go scoring
-- engine as a normalized [0,1] value). `ratings/service.ts` owns the one
-- normalization step between the two; this table stores the raw score
-- exactly as submitted so the normalization formula can change later
-- without a lossy migration.
CREATE TABLE ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks (id) ON DELETE CASCADE,
  requester_address TEXT NOT NULL REFERENCES users (address),
  score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
