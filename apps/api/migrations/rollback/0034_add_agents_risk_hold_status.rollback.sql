-- Manual rollback for 0034_add_agents_risk_hold_status.sql (T-2008). NOT
-- wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory.
--
-- DESTRUCTIVE: drops the audit log table and every Agent's risk hold
-- status recorded in it.
DROP TABLE IF EXISTS risk_hold_audit_logs;
ALTER TABLE agents DROP COLUMN IF EXISTS risk_hold_status;

DELETE FROM schema_migrations WHERE id = '0034_add_agents_risk_hold_status.sql';
