-- Manual rollback for 0035_create_interaction_events.sql (T-1900).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory.
DROP TABLE IF EXISTS interaction_events;

DELETE FROM schema_migrations WHERE id = '0035_create_interaction_events.sql';
