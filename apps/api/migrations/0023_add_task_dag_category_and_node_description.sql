-- Feature 17 (multi-agent-dag-orchestration), T-1701.
-- N4 round-2 real finding (P1): `createDagSchema` (T-1701) already requires
-- the request to supply `category` (DAG-level) and each node's
-- `description`, but 0021_create_task_dags.sql's data model has no column
-- for either — repository.ts silently accepted and then discarded both,
-- and the response couldn't return them. Once T-1702 activates a node
-- (creates the node's real `tasks` row), `tasks.category`/`tasks.
-- description` are NOT NULL — this data would already be permanently lost
-- by then. Follow-up migration rather than an edit to 0021/0022 (both
-- already N4-reviewed and their Tasks marked complete), same "不篡改已执行的"
-- convention as 0014 following up on 0013.
--
-- `category` lives on task_dags (one value for the whole DAG, matching how
-- the request schema declared it — DAG-level, not per-node); `description`
-- lives on task_dag_nodes (per-node, matching how the request schema
-- declared it — each node describes its own sub-task, e.g. "调研"/"撰写"/
-- "校对" in design.md's own example, not one shared DAG-wide description).
-- Both use the exact same ADD-DEFAULT-then-DROP-DEFAULT two-step shape as
-- 0013/0014/0022 for the identical reason (any rows that already exist by
-- the time this runs get a real, non-null backfill value rather than
-- failing the ALTER TABLE outright; the immediate DROP DEFAULT then
-- requires every future INSERT to supply both explicitly).
--
-- Deliberately no IF NOT EXISTS anywhere in this file (see
-- 0001_create_users.sql's header comment for the rationale).
ALTER TABLE task_dags ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE task_dags ALTER COLUMN category DROP DEFAULT;

ALTER TABLE task_dag_nodes ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE task_dag_nodes ALTER COLUMN description DROP DEFAULT;
