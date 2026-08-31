-- Manual rollback for 0017_ollama_embedding_dimension.sql (T-1309).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE, and NOT a data-preserving reversal: 1024-dim Ollama vectors
-- and 1536-dim OpenAI vectors describe unrelated vector spaces (same
-- reasoning as the forward migration's own header comment), so reverting
-- the column type back to vector(1536) requires clearing whatever
-- 1024-dim rows exist first, exactly as the forward migration cleared the
-- 1536-dim rows it replaced. This rollback undoes 0017's schema shape; it
-- does not and cannot restore whichever provider's vectors were in place
-- immediately before 0017 first ran.
DROP INDEX IF EXISTS agent_embeddings_ivfflat_idx;

DELETE FROM agent_embeddings;
DELETE FROM task_embeddings;

ALTER TABLE agent_embeddings
  DROP CONSTRAINT agent_embeddings_dimension_check;
ALTER TABLE agent_embeddings
  ALTER COLUMN embedding TYPE vector(1536);
ALTER TABLE agent_embeddings
  ADD CONSTRAINT agent_embeddings_dimension_check CHECK (dimension = 1536);

ALTER TABLE task_embeddings
  DROP CONSTRAINT task_embeddings_dimension_check;
ALTER TABLE task_embeddings
  ALTER COLUMN embedding TYPE vector(1536);
ALTER TABLE task_embeddings
  ADD CONSTRAINT task_embeddings_dimension_check CHECK (dimension = 1536);

CREATE INDEX agent_embeddings_ivfflat_idx ON agent_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

DELETE FROM schema_migrations WHERE id = '0017_ollama_embedding_dimension.sql';
