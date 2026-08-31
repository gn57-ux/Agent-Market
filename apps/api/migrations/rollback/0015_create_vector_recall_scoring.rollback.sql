-- Manual rollback for 0015_create_vector_recall_scoring.sql (T-1300).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE: drops all stored Agent/task embeddings and any recorded
-- communication scores / semantic-similarity data. Does not drop the
-- `vector` extension itself — other databases/schemas on the same Postgres
-- instance may depend on it, and re-creating it is cheap and side-effect-
-- free (`CREATE EXTENSION IF NOT EXISTS`) if this migration is reapplied.
DROP TABLE IF EXISTS agent_embeddings;
DROP TABLE IF EXISTS task_embeddings;

ALTER TABLE ratings
  DROP COLUMN IF EXISTS communication_score;

ALTER TABLE recommendation_candidates
  DROP COLUMN IF EXISTS semantic_similarity,
  DROP COLUMN IF EXISTS reputation_signals;

DELETE FROM schema_migrations WHERE id = '0015_create_vector_recall_scoring.sql';
