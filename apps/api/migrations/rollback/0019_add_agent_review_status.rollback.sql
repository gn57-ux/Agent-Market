-- Manual rollback for 0019_add_agent_review_status.sql (T-1603).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE: drops all recorded Agent review audit history
-- (agent_review_audit_logs) and both new columns (review_status,
-- pricing_type), including any real audit trail accumulated since the
-- migration was applied.
DROP TABLE IF EXISTS agent_review_audit_logs;

ALTER TABLE agents
  DROP COLUMN IF EXISTS review_status,
  DROP COLUMN IF EXISTS pricing_type;

DELETE FROM schema_migrations WHERE id = '0019_add_agent_review_status.sql';
