-- Manual rollback for 0040_create_arbitration_committee_tables.sql
-- (T-2102). NOT wired into any automated `migrate down` command -- same
-- forward-only policy as every other rollback file in this directory.
--
-- DESTRUCTIVE: drops the entire arbitration committee membership roster,
-- role-rotation log, and decision/execution history.
DROP TABLE IF EXISTS arbitration_decisions;
DROP FUNCTION IF EXISTS arbitration_decisions_has_distinct_valid_signers(TEXT[]);
DROP TABLE IF EXISTS arbitration_upgrade_log;
DROP TABLE IF EXISTS arbitration_committee_members;

DELETE FROM schema_migrations WHERE id = '0040_create_arbitration_committee_tables.sql';
