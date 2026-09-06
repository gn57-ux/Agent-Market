-- Feature 19 (ctr-online-learning), T-1912 (schema prerequisite for
-- F-1919's observability table).
--
-- design.md's own schema section defines `ctr_models`, `dispatch_rerank_runs`,
-- and `shadow_ranking_results` together as one cohesive data model — this
-- migration creates all three verbatim, in FK dependency order
-- (ctr_models → dispatch_rerank_runs → shadow_ranking_results), even
-- though only `dispatch_rerank_runs` has a real writer in THIS Task
-- (T-1912's own scope: F-1919's call-chain observability). `ctr_models`
-- (T-1905's write-side: training/promotion) and `shadow_ranking_results`
-- (T-1906's write-side: shadow-vs-real comparison) are real, already-
-- specified FK targets/dependents this migration must establish now —
-- `dispatch_rerank_runs.ranking_policy_version` cannot reference a table
-- that doesn't exist yet, and fragmenting one specified data model across
-- three separate migrations, one per consuming Task, would only add
-- migration-ordering fragility with no real benefit (T-1905/T-1906 simply
-- INSERT/UPDATE into tables this migration already created — no further
-- schema change is needed from either of them).
--
-- `ctr_models` — the `ranking_policy_version` registry (F-1922): each row
-- is one trained fusion-weight configuration. `is_active`'s partial unique
-- index is the single "current production version" pointer — promotion/
-- rollback (T-1905) is a pointer flip, never a re-train.
CREATE TABLE ctr_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version TEXT NOT NULL UNIQUE,
  data_snapshot_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  offline_metrics JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ctr_models_single_active_idx ON ctr_models (is_active) WHERE is_active;

-- `dispatch_rerank_runs` — F-1919's own observability table: one row per
-- real Node→Python `/rerank` call, regardless of whether its result was
-- ultimately adopted (SHADOW calls never are). `rerank_service_version`
-- (Python 服务/LangGraph 图版本) and `ranking_policy_version` (融合权重/
-- 策略版本, nullable — no trained policy exists until T-1905's first
-- promotion) are two INDEPENDENT columns per F-1922's own hard
-- requirement — never merged into one version value. `trace_id` is the
-- one value that lets a single request's Node/Go/Python log lines be
-- correlated (F-1919's literal "跨三个进程...可追踪" requirement).
CREATE TABLE dispatch_rerank_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES recommendation_runs (id),
  stage TEXT NOT NULL CHECK (stage IN ('SHADOW', 'GRADUAL', 'PRIMARY')),
  rerank_service_version TEXT NOT NULL,
  ranking_policy_version UUID REFERENCES ctr_models (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'TIMEOUT', 'ERROR', 'DEGRADED')),
  latency_ms INTEGER NOT NULL,
  adopted BOOLEAN NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dispatch_rerank_runs_run_id_idx ON dispatch_rerank_runs (run_id);
CREATE INDEX dispatch_rerank_runs_stage_idx ON dispatch_rerank_runs (stage, created_at);

-- `shadow_ranking_results` — T-1906's own write target (shadow-vs-real
-- comparison), created here for the same FK-dependency-ordering reason.
CREATE TABLE shadow_ranking_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES recommendation_runs (id),
  rerank_run_id UUID NOT NULL REFERENCES dispatch_rerank_runs (id),
  ctr_model_id UUID REFERENCES ctr_models (id),
  shadow_ranked_agent_ids JSONB NOT NULL,
  real_ranked_agent_ids JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
