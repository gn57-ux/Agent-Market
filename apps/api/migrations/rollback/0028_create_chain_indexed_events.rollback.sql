-- Manual rollback for 0028_create_chain_indexed_events.sql (T-1805).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory.
DROP TABLE IF EXISTS chain_indexed_events;

DELETE FROM schema_migrations WHERE id = '0028_create_chain_indexed_events.sql';
