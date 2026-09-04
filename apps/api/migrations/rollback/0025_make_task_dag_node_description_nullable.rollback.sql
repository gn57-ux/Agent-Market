-- Manual rollback for 0025_make_task_dag_node_description_nullable.sql
-- (T-1704).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE (in the narrow sense of restoring the old placeholder
-- behavior): any node whose description is genuinely NULL (whether it
-- predates 0023, or was NULLed by this migration's own forward direction)
-- gets forced back to '' so the restored NOT NULL constraint can be
-- applied -- indistinguishable again from a real empty description, same
-- as before this migration ran.
--
-- No FK/separate-table ordering concern (same reasoning as 0023/0024's own
-- rollbacks): this migration only touched a column's nullability/values on
-- 0021's own task_dag_nodes table, so DROP TABLE in 0021's rollback
-- removes it regardless of whether this file runs first -- but 0021's
-- rollback must still explicitly clear THIS migration's schema_migrations
-- row too (same bookkeeping-desync risk as 0023/0024), so this file's own
-- removal alone is not sufficient cleanup if 0021 is later rolled back
-- without this file having run.
UPDATE task_dag_nodes SET description = '' WHERE description IS NULL;
ALTER TABLE task_dag_nodes ALTER COLUMN description SET NOT NULL;

DELETE FROM schema_migrations WHERE id = '0025_make_task_dag_node_description_nullable.sql';
