-- Manual rollback for 0022_add_task_dag_node_expert_fields.sql (T-1701).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE: drops task_dag_node_skills entirely (losing every node's
-- recorded skill requirements) and the expert_type column (losing every
-- node's recorded expert type) -- any DAG created after this rollback loses
-- the ability to record either until the migration is reapplied.
DROP TABLE IF EXISTS task_dag_node_skills;

ALTER TABLE task_dag_nodes DROP COLUMN IF EXISTS expert_type;

DELETE FROM schema_migrations WHERE id = '0022_add_task_dag_node_expert_fields.sql';
