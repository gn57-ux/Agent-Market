-- Manual rollback for 0032_add_agents_baseline_evaluation_status.sql
-- (T-2009). NOT wired into any automated `migrate down` command -- same
-- forward-only policy as every other rollback file in this directory.
--
-- DESTRUCTIVE: drops the column and every Agent's baseline evaluation
-- status recorded in it.
ALTER TABLE agents DROP COLUMN IF EXISTS baseline_evaluation_status;

DELETE FROM schema_migrations WHERE id = '0032_add_agents_baseline_evaluation_status.sql';
