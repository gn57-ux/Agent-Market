-- Manual rollback for 0008_create_acceptance_permits.sql (T-801, edited in
-- place by T-806 — see that migration's header comment for why this is not
-- a new 0009 migration).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as 0005/0006/0007's rollbacks. A human who has confirmed this is
-- the right action runs this file directly and then manually removes the
-- corresponding row from `schema_migrations` if the migration should be
-- considered un-applied.
--
-- DESTRUCTIVE only in the sense of losing whatever acceptance-permit
-- issuance/consumption history and recommendation_runs.input_digest values
-- have been recorded since this migration was applied; it does not touch
-- any other table.
DROP TABLE IF EXISTS acceptance_permits;
ALTER TABLE recommendation_runs DROP COLUMN IF EXISTS input_digest;

DELETE FROM schema_migrations WHERE id = '0008_create_acceptance_permits.sql';
