-- Manual rollback for 0006_add_dispatch_matching_fields.sql (T-700).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as 0005_create_tasks.rollback.sql (see that file's header
-- comment). A human who has confirmed this is the right action runs this
-- file directly and then manually removes the corresponding row from
-- `schema_migrations` if the migration should be considered un-applied.
--
-- DESTRUCTIVE only in the sense of losing whatever level/capacity/
-- acceptance/ban data has been written into these columns/table since they
-- were added; it does not touch any other column or table.
DROP TABLE IF EXISTS blocked_wallets;

DROP INDEX IF EXISTS tasks_accepted_agent_status_idx;

ALTER TABLE tasks
  DROP COLUMN IF EXISTS accepted_at,
  DROP COLUMN IF EXISTS accepted_agent_address,
  DROP COLUMN IF EXISTS accepted_agent_id,
  DROP COLUMN IF EXISTS required_agent_level;

ALTER TABLE agents
  DROP COLUMN IF EXISTS max_concurrent_tasks,
  DROP COLUMN IF EXISTS level;

DELETE FROM schema_migrations WHERE id = '0006_add_dispatch_matching_fields.sql';
