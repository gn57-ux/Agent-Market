-- Manual rollback for 0027_create_outbox_events.sql (T-1800).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory.
DROP TABLE IF EXISTS outbox_events;

DELETE FROM schema_migrations WHERE id = '0027_create_outbox_events.sql';
