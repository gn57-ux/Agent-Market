-- Manual rollback for 0013_add_agent_task_credentials.sql (T-1200).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE only in the sense of losing whatever protocol_version/
-- credential_ref/expert_type data has been written since these columns
-- were added; it does not touch any other column or table.
ALTER TABLE tasks
  DROP COLUMN IF EXISTS expert_type;

ALTER TABLE agents
  DROP COLUMN IF EXISTS credential_ref,
  DROP COLUMN IF EXISTS protocol_version;

DELETE FROM schema_migrations WHERE id = '0013_add_agent_task_credentials.sql';
