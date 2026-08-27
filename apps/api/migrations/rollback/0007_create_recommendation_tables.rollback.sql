-- Manual rollback for 0007_create_recommendation_tables.sql (T-705).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as 0005_create_tasks.rollback.sql/0006's rollback. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE only in the sense of losing whatever recommendation run/
-- candidate history has been recorded since these tables were created; it
-- does not touch any other table.
DROP TABLE IF EXISTS recommendation_candidates;
DROP TABLE IF EXISTS recommendation_runs;

DELETE FROM schema_migrations WHERE id = '0007_create_recommendation_tables.sql';
