-- Manual rollback for 0021_create_task_dags.sql (T-1700).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE: dropping these three tables permanently loses every DAG's
-- topology (nodes/edges) and DAG-level status; the underlying per-node
-- `tasks` rows are NOT dropped (task_dag_nodes.task_id only references
-- them, ON DELETE CASCADE runs the other direction), so already-created
-- on-chain tasks remain intact and resolvable individually, just no longer
-- grouped under a DAG.
--
-- Deliberately NO CASCADE (N4 real finding, round 2 — reverted from an
-- earlier CASCADE version): 0022_add_task_dag_node_expert_fields.sql
-- (T-1701) added task_dag_node_skills with a FK into task_dag_nodes. A
-- first attempt at this rollback used CASCADE to route around the
-- resulting "other objects depend on it" error — but CASCADE only drops
-- the dependent STRUCTURE, not 0022's `schema_migrations` bookkeeping row;
-- after that, `runMigrations` would see 0022 already recorded as applied,
-- skip it, and leave a database that's missing `expert_type`/
-- `task_dag_node_skills` entirely despite `schema_migrations` insisting
-- 0022 ran — a silent, worse inconsistency than the loud failure it was
-- meant to avoid.
--
-- The correct fix is procedural, not a CASCADE: roll back every migration
-- that depends on this one FIRST, in reverse order, using each migration's
-- OWN rollback file (which correctly clears ITS OWN schema_migrations
-- row) — i.e. run
-- 0022_add_task_dag_node_expert_fields.rollback.sql before this file, not
-- instead of it. A plain (non-CASCADE) DROP TABLE failing here when 0022
-- hasn't been rolled back yet is the intended safety behavior: it forces
-- the correct order instead of silently completing an incomplete rollback.
--
-- 0023_add_task_dag_category_and_node_description.sql,
-- 0024_add_task_dag_node_title_and_deadline.sql,
-- 0025_make_task_dag_node_description_nullable.sql, and
-- 0026_add_task_dag_node_selected_predecessors.sql are a DIFFERENT case:
-- they only ADD/ALTER plain columns onto these same tables (no separate
-- table, no FK), so DROP TABLE here succeeds and silently removes their
-- columns along with everything else, REGARDLESS of whether their own
-- rollbacks ran first — there is no FK to force the correct order the way
-- there is for 0022. Recommended practice is still reverse order (0026,
-- then 0025, then 0024, then 0023, then 0022, then this file), but since
-- that can't be enforced the same way, this file takes explicit
-- responsibility for also clearing 0023's/0024's/0025's/0026's
-- schema_migrations rows unconditionally below, so a reapply via
-- `runMigrations` can never skip any of them as "already applied" over
-- columns that no longer exist.
DROP TABLE IF EXISTS task_dag_edges;
DROP TABLE IF EXISTS task_dag_nodes;
DROP TABLE IF EXISTS task_dags;

DELETE FROM schema_migrations
  WHERE id IN (
    '0021_create_task_dags.sql',
    '0023_add_task_dag_category_and_node_description.sql',
    '0024_add_task_dag_node_title_and_deadline.sql',
    '0025_make_task_dag_node_description_nullable.sql',
    '0026_add_task_dag_node_selected_predecessors.sql'
  );
