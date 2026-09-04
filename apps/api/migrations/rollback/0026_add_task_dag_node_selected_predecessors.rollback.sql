-- Manual rollback for 0026_add_task_dag_node_selected_predecessors.sql
-- (T-1706).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory.
--
-- No FK/separate-table ordering concern (same reasoning as 0023/0024/
-- 0025's own rollbacks): this migration only added a column on 0021's own
-- task_dag_nodes table, so DROP TABLE in 0021's rollback removes it
-- regardless of whether this file runs first -- but 0021's rollback must
-- still explicitly clear THIS migration's schema_migrations row too (same
-- bookkeeping-desync risk as every prior follow-up), so this file's own
-- removal alone is not sufficient cleanup if 0021 is later rolled back
-- without this file having run.
ALTER TABLE task_dag_nodes DROP COLUMN selected_predecessor_ids;

DELETE FROM schema_migrations WHERE id = '0026_add_task_dag_node_selected_predecessors.sql';
