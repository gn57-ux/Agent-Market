-- Manual rollback for 0033_create_ctr_models_and_rerank_observability.sql
-- (T-1912). NOT wired into any automated `migrate down` command — same
-- forward-only policy as every other rollback file in this directory.
-- Drop order is the reverse of creation (FK dependents first).
DROP TABLE IF EXISTS shadow_ranking_results;
DROP TABLE IF EXISTS dispatch_rerank_runs;
DROP TABLE IF EXISTS ctr_models;

DELETE FROM schema_migrations WHERE id = '0033_create_ctr_models_and_rerank_observability.sql';
