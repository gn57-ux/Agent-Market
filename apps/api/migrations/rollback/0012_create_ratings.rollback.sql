-- Manual rollback for 0012_create_ratings.sql (T-1003).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory.
DROP TABLE IF EXISTS ratings;

DELETE FROM schema_migrations WHERE id = '0012_create_ratings.sql';
