-- Feature 13 (vector-recall-scoring), T-1301.
--
-- design.md's `apps/api/src/modules/embeddings/budget.ts`: "月度/单次预算
-- 计数器...一个简单的 Postgres 计数表，不引入 Redis 等新基础设施". One row per
-- calendar month (`year_month`, e.g. '2026-08'), tracking how many
-- `EmbeddingProvider.embed` calls have actually been attempted this month —
-- not how many succeeded, since a call that hit a timeout/rate-limit still
-- consumed real quota against the Provider's own account, which is exactly
-- the kind of spend this counter exists to bound (F-1303: "独立的月度调用
-- 次数上限").
--
-- No FK, no relation to any other table — this is a pure operational
-- counter, deliberately isolated from business data so truncating/resetting
-- it (a human operational action, not exposed via any API) can never affect
-- Agent/task data.
CREATE TABLE embedding_budget_usage (
  year_month TEXT PRIMARY KEY,
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0)
);
