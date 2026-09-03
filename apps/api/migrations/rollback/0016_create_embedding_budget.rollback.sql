-- Manual rollback for 0016_create_embedding_budget.sql (T-1301).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE only in the sense of losing this month's (and any prior
-- month's) recorded call counts — a purely operational counter, not
-- business data.
DROP TABLE IF EXISTS embedding_budget_usage;

DELETE FROM schema_migrations WHERE id = '0016_create_embedding_budget.sql';
