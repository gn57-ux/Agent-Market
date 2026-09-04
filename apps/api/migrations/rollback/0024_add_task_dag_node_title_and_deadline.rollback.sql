-- Manual rollback for 0024_add_task_dag_node_title_and_deadline.sql
-- (T-1702).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE: drops every node's recorded title and delivery deadline.
--
-- Same as 0023's rollback: this migration only ADDs plain columns onto
-- 0021's task_dag_nodes, no separate table/FK, so DROP TABLE in 0021's
-- rollback removes these columns automatically regardless of whether this
-- file runs first -- but 0021's rollback must still explicitly clear THIS
-- migration's schema_migrations row too (same silent-bookkeeping-desync
-- risk as 0023), so this file's own removal alone is not sufficient
-- cleanup if 0021 is later rolled back without this file having run.
ALTER TABLE task_dag_nodes DROP COLUMN IF EXISTS title;
ALTER TABLE task_dag_nodes DROP COLUMN IF EXISTS delivery_deadline;

DELETE FROM schema_migrations WHERE id = '0024_add_task_dag_node_title_and_deadline.sql';
