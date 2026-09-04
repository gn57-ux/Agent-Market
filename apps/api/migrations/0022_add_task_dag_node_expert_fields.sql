-- Feature 17 (multi-agent-dag-orchestration), T-1701.
-- design.md's interface contract for `POST /dags` states the request
-- carries "每节点子预算+专家类型/技能要求" (per-node sub-budget + expert
-- type/skill requirements), but 0021_create_task_dags.sql's data model
-- (T-1700) didn't include either — 0021 is already N4-reviewed and its
-- Task marked complete, so per this repo's "不篡改已执行的" convention this
-- is a follow-up migration, not an edit to 0021 (same pattern as
-- 0014_drop_expert_type_default.sql following up on
-- 0013_add_agent_task_credentials.sql).
--
-- Two options compared for where a node's expert-type/skill requirements
-- live before that node's real `tasks` row exists (T-1702 doesn't create
-- the real task until the node becomes READY, which can be long after DAG
-- creation for a deep node):
--
-- Option A (chosen): persist them on task_dag_nodes/a new
-- task_dag_node_skills table at DAG-creation time (T-1701), mirroring
-- tasks.expert_type / task_skills exactly. T-1702 copies these fields
-- verbatim into the real `tasks`/`task_skills` rows it creates for that
-- node — the DAG node is the single source of truth for what kind of
-- expert money 1701 promised, T-1702 never invents or re-asks for it.
--
-- Option B (not chosen): defer asking for expert_type/skills until T-1702
-- activates a node, i.e. `POST /dags/:dagId/activate` (or the internal
-- executor) would need this information supplied some other way at
-- activation time. Rejected: contradicts design.md's own already-written
-- interface contract (these fields are documented as part of `POST /dags`'s
-- request, not activation), and would mean the requester commits a DAG's
-- shape at creation time but its Agent-matching criteria only get decided
-- node-by-node much later — a worse authoring experience with no
-- compensating benefit, since nothing about expert_type/skills is expected
-- to change between DAG creation and a node's activation.
--
-- expert_type mirrors tasks.expert_type's exact enum and the exact same
-- two-step ADD-DEFAULT-then-DROP-DEFAULT shape as 0013/0014
-- (0013_add_agent_task_credentials.sql / 0014_drop_expert_type_default.sql)
-- for the identical reason: any task_dag_nodes rows that already exist by
-- the time this migration runs (T-1700 and T-1701 both being real,
-- separately-shippable Tasks within the same Feature, a real deployment
-- window could have rows between them) get backfilled to 'AUTOMATION'
-- rather than failing this ALTER TABLE outright; the immediate DROP
-- DEFAULT then ensures every INSERT from this point on must supply
-- expert_type explicitly, not silently default to it.
--
-- Deliberately no IF NOT EXISTS anywhere in this file (see
-- 0001_create_users.sql's header comment for the rationale).
ALTER TABLE task_dag_nodes
  ADD COLUMN expert_type TEXT NOT NULL DEFAULT 'AUTOMATION'
    CHECK (expert_type IN (
      'DATA_ANALYSIS', 'CONTENT_GENERATION', 'SOFTWARE_DEVELOPMENT', 'RESEARCH', 'AUTOMATION'
    ));

ALTER TABLE task_dag_nodes ALTER COLUMN expert_type DROP DEFAULT;

-- Mirrors task_skills (0005_create_tasks.sql) exactly, same reasoning
-- (multi-valued skill tags, PK on the pair keeps `skill_tag = $1` filtering
-- a plain indexed equality lookup instead of an array-containment query).
CREATE TABLE task_dag_node_skills (
  node_id UUID NOT NULL REFERENCES task_dag_nodes (id) ON DELETE CASCADE,
  skill_tag TEXT NOT NULL,
  PRIMARY KEY (node_id, skill_tag)
);

CREATE INDEX task_dag_node_skills_skill_tag_idx ON task_dag_node_skills (skill_tag);
