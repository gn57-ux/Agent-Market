-- Feature 13 (vector-recall-scoring), T-1300.
--
-- See specs/13-vector-recall-scoring/design.md's "数据模型" section for the
-- full rationale. Summary of decisions already made there:
--
-- `agent_embeddings`/`task_embeddings`: one row per entity, primary key IS
-- the foreign key (`agent_id`/`task_id`) — a single current vector, not a
-- history table. `embedding_version` identifies which model/config
-- produced this vector (for future re-generation decisions), not a
-- multi-version-coexistence scheme. `dimension` is redundant with the
-- `vector(1536)` column type itself but kept as an explicit, queryable
-- CHECK-constrained column so a future model swap to a different dimension
-- fails loudly and immediately rather than requiring every consumer to
-- introspect the column type.
--
-- `ratings.communication_score`: additive nullable column on Feature 10's
-- existing table (F-1310) — same optional-1..5-star shape as the existing
-- `score` column, submitted in the same `POST /tasks/:taskId/ratings` call
-- (T-1306), never required.
--
-- `recommendation_candidates` new columns: additive-only against Feature
-- 7's existing table (0007_create_recommendation_tables.sql), for AC-1307's
-- replay requirement — `semantic_similarity`/`reputation_signals` are
-- `NULL` for every existing v0.1 row and every future v0.1 row (v0.1 never
-- computes either), populated only by v0.2's candidate assembly.
--
-- pgvector availability: `CREATE EXTENSION` is deliberately the FIRST
-- statement, outside any later DDL that depends on it, so a missing
-- extension fails this migration immediately with Postgres's own error —
-- migrate.ts's runner (see its own doc comment) intercepts that specific
-- failure and re-throws a clear Chinese-language explanation rather than
-- letting the raw "extension \"vector\" is not available" message reach
-- whoever ran the migration (design.md's "安全/兼容性" requirement).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agent_embeddings (
  agent_id UUID PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension = 1536),
  embedding_version TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `lists = 100` is a one-period reasonable default (design.md: "不做超参
-- 调优"), not a value tuned against this deployment's actual candidate
-- volume — ivfflat is an approximate-nearest-neighbor index, a known,
-- accepted tradeoff (tasks.md's own "风险" section) rather than an oversight.
CREATE INDEX agent_embeddings_ivfflat_idx ON agent_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE task_embeddings (
  task_id UUID PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension = 1536),
  embedding_version TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ratings
  ADD COLUMN communication_score SMALLINT
    CHECK (communication_score IS NULL OR communication_score BETWEEN 1 AND 5);

ALTER TABLE recommendation_candidates
  ADD COLUMN semantic_similarity DOUBLE PRECISION,
  ADD COLUMN reputation_signals JSONB;
