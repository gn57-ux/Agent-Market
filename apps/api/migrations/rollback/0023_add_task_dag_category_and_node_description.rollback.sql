-- Manual rollback for 0023_add_task_dag_category_and_node_description.sql
-- (T-1701).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE: drops every DAG's category and every node's description.
--
-- Unlike 0022's rollback, this one does NOT need to run before
-- 0021_create_task_dags.rollback.sql to avoid a dependency error: this
-- migration only ADDs plain columns onto 0021's own tables, it doesn't
-- create a separate table with a foreign key into them (0022's
-- task_dag_node_skills does) -- `DROP TABLE task_dags`/`DROP TABLE
-- task_dag_nodes` removes their own columns automatically regardless of
-- whether this file has run first. Still recommended to roll back in
-- reverse migration order (0023, then 0022, then 0021) as a general
-- discipline, but this file specifically has no hard ordering requirement.
ALTER TABLE task_dags DROP COLUMN IF EXISTS category;
ALTER TABLE task_dag_nodes DROP COLUMN IF EXISTS description;

DELETE FROM schema_migrations WHERE id = '0023_add_task_dag_category_and_node_description.sql';
