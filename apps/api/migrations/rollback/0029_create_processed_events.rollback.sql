-- Manual rollback for 0029_create_processed_events.sql (T-1802).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory.
DROP TABLE IF EXISTS processed_events;

DELETE FROM schema_migrations WHERE id = '0029_create_processed_events.sql';
