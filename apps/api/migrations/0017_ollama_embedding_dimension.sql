-- Feature 13 (vector-recall-scoring), T-1309 — Ollama localization change
-- (specs/13-vector-recall-scoring/design.md v1.2's data-model section).
--
-- Does NOT modify 0015_create_vector_recall_scoring.sql (already applied
-- against real deployments; git-workflow.md's "禁止未经确认的破坏性迁移直接
-- 应用到共享环境" — a NEW forward migration is the only allowed path).
--
-- 1536→1024 is not a convertible change: OpenAI's text-embedding-3-small
-- and Ollama's bge-m3 are different models with unrelated vector spaces, so
-- there is no meaningful per-row conversion — every existing row's vector
-- describes a space this deployment no longer uses (F-1302's requirements.md
-- v1.2: "不同模型的向量空间不可混用"). This migration therefore CLEARS both
-- tables outright rather than attempting any resize/reinterpretation, then
-- rebuilds the column type, CHECK constraint, and ivfflat index for 1024
-- dimensions. T-1310's idempotent backfill script is what actually
-- repopulates real Ollama-derived vectors afterward — deliberately a
-- separate step, run outside any migration transaction (F-1303/tasks.md's
-- explicit "不得在数据库迁移事务内调用 Ollama").
--
-- task_embeddings has no ivfflat index (see 0015's own header comment: the
-- read path always looks up a specific task's vector by its own PK, never
-- an ANN search across task vectors) — so only agent_embeddings_ivfflat_idx
-- needs dropping/rebuilding here.
DROP INDEX IF EXISTS agent_embeddings_ivfflat_idx;

DELETE FROM agent_embeddings;
DELETE FROM task_embeddings;

ALTER TABLE agent_embeddings
  DROP CONSTRAINT agent_embeddings_dimension_check;
ALTER TABLE agent_embeddings
  ALTER COLUMN embedding TYPE vector(1024);
ALTER TABLE agent_embeddings
  ADD CONSTRAINT agent_embeddings_dimension_check CHECK (dimension = 1024);

ALTER TABLE task_embeddings
  DROP CONSTRAINT task_embeddings_dimension_check;
ALTER TABLE task_embeddings
  ALTER COLUMN embedding TYPE vector(1024);
ALTER TABLE task_embeddings
  ADD CONSTRAINT task_embeddings_dimension_check CHECK (dimension = 1024);

-- Same non-tuned `lists = 100` default as 0015's original index (design.md:
-- "不做超参调优") — this deployment's actual candidate volume hasn't
-- changed, only the vector dimension has.
CREATE INDEX agent_embeddings_ivfflat_idx ON agent_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
