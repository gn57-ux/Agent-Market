-- Manual rollback for 0041_create_arbitration_recusals.sql (T-2107). NOT
-- wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory.
--
-- DESTRUCTIVE: drops the entire recusal record history.
DROP TABLE IF EXISTS arbitration_recusals;

DELETE FROM schema_migrations WHERE id = '0041_create_arbitration_recusals.sql';
