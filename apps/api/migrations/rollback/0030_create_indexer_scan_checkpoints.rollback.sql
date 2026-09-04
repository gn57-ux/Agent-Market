-- Manual rollback for 0030_create_indexer_scan_checkpoints.sql (T-1806).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory.
DROP TABLE IF EXISTS indexer_scan_checkpoints;

DELETE FROM schema_migrations WHERE id = '0030_create_indexer_scan_checkpoints.sql';
