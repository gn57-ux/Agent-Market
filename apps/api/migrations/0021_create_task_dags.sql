-- Feature 17 (multi-agent-dag-orchestration), T-1700.
-- task_dags / task_dag_nodes / task_dag_edges per
-- specs/17-multi-agent-dag-orchestration/design.md's "数据模型" section.
--
-- Design decision (not in design.md's SQL draft, added here — compared two
-- directionally different options for how task_dag_edges references
-- task_dag_nodes, per this project's "重要设计必须至少比较两个方案" rule):
--
-- Option A (design.md's literal draft): task_dag_edges.from_node_id /
-- to_node_id are plain FKs to task_dag_nodes(id), with no constraint tying
-- them to the same dag_id as the edge row itself. Simpler (one FK per
-- column), but a bug in the application layer (e.g. reusing a node_id from
-- a different DAG by mistake) could silently create a cross-DAG edge —
-- topological validation (T-1701's cycle/dangling-dependency check) would
-- then have to defend against a case the schema itself permits.
--
-- Option B (chosen): task_dag_nodes gets a UNIQUE (dag_id, id) constraint
-- (redundant with id's own primary-key uniqueness, but required for it to
-- be a valid composite FK target), and task_dag_edges' two node references
-- become composite FKs against (dag_id, node_id) instead of plain (node_id)
-- FKs. This makes "an edge's endpoints belong to the same DAG the edge
-- itself belongs to" a database-enforced invariant, not an application-only
-- one — consistent with this migration file's own established pattern
-- elsewhere in this repo of pairing app-layer validation with a DB
-- constraint of last resort (see 0005_create_tasks.sql's
-- tasks_budget_positive comment for the same reasoning applied to a
-- different invariant). Chosen because T-1701's cycle detection already
-- has to load "all edges for this dag_id" — a cross-DAG edge slipping
-- through would corrupt that computation in a way that's hard to detect
-- from outside the DAG in question, and closing it at the schema layer
-- costs one extra UNIQUE constraint, not a new table or trigger.
--
-- Deliberately no IF NOT EXISTS anywhere in this file (see
-- 0001_create_users.sql's header comment for the rationale).
CREATE TABLE task_dags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_address TEXT NOT NULL REFERENCES users (address),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_dags_requester_address_format CHECK (requester_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT task_dags_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'))
);

-- node_role/node_status enumerate F-1702's three topology roles and the
-- DAG-layer readiness lifecycle (design.md: "node_status 是 DAG 层的拓扑就绪
-- 状态...node_status = TASK_ACTIVE 期间的真实进度以 tasks.status 为准").
-- task_id is nullable (a node has no real on-chain task until its
-- preconditions are satisfied and it becomes READY -> TASK_ACTIVE) and
-- individually UNIQUE (a real task belongs to at most one DAG node; NULL
-- values are not considered equal by Postgres UNIQUE, so many nodes can
-- simultaneously have task_id = NULL before activation).
CREATE TABLE task_dag_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dag_id UUID NOT NULL REFERENCES task_dags (id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks (id),
  node_role TEXT NOT NULL,
  node_status TEXT NOT NULL DEFAULT 'PENDING',
  sub_budget NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_dag_nodes_node_role_check CHECK (node_role IN ('SERIAL', 'PARALLEL', 'AGGREGATE')),
  CONSTRAINT task_dag_nodes_node_status_check CHECK (
    node_status IN ('PENDING', 'READY', 'TASK_ACTIVE', 'DONE', 'FAILED', 'MANUAL_TAKEOVER')
  ),
  -- Mirrors tasks_budget_positive (0005_create_tasks.sql): a zero/negative
  -- sub-budget would pass every application-layer check that predates this
  -- constraint and then be permanently unfundable once its node activates.
  CONSTRAINT task_dag_nodes_sub_budget_positive CHECK (sub_budget > 0),
  CONSTRAINT task_dag_nodes_task_id_unique UNIQUE (task_id),
  -- Composite-FK target for task_dag_edges (see this file's header
  -- comment, design decision, option B).
  CONSTRAINT task_dag_nodes_dag_id_id_unique UNIQUE (dag_id, id)
);

CREATE INDEX task_dag_nodes_dag_id_idx ON task_dag_nodes (dag_id);

-- Edges express "from_node_id must reach a terminal state before
-- to_node_id can become READY" (T-1701/T-1703's readiness computation).
-- Composite FKs (dag_id, from_node_id) / (dag_id, to_node_id) against
-- task_dag_nodes (dag_id, id) — not plain (from_node_id)/(to_node_id) FKs
-- against task_dag_nodes(id) — enforce that both endpoints belong to the
-- same DAG as the edge itself (design decision, option B, see header).
CREATE TABLE task_dag_edges (
  dag_id UUID NOT NULL REFERENCES task_dags (id) ON DELETE CASCADE,
  from_node_id UUID NOT NULL,
  to_node_id UUID NOT NULL,
  PRIMARY KEY (from_node_id, to_node_id),
  CONSTRAINT task_dag_edges_from_node_fk FOREIGN KEY (dag_id, from_node_id)
    REFERENCES task_dag_nodes (dag_id, id) ON DELETE CASCADE,
  CONSTRAINT task_dag_edges_to_node_fk FOREIGN KEY (dag_id, to_node_id)
    REFERENCES task_dag_nodes (dag_id, id) ON DELETE CASCADE,
  -- A node cannot be its own precondition — without this, T-1701's cycle
  -- detection would have to treat a 1-node self-loop as a special case of
  -- "cycle" rather than being unrepresentable in the first place.
  CONSTRAINT task_dag_edges_no_self_loop CHECK (from_node_id <> to_node_id)
);

CREATE INDEX task_dag_edges_dag_id_idx ON task_dag_edges (dag_id);
-- from_node_id is already indexed as the PRIMARY KEY's leading column;
-- to_node_id needs its own index for the readiness query's opposite
-- direction ("find all edges whose to_node_id is this node", i.e. "what
-- are this node's preconditions").
CREATE INDEX task_dag_edges_to_node_id_idx ON task_dag_edges (to_node_id);
