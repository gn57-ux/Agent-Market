import type { Pool, PoolClient } from "pg";
import type { CreateDagInput } from "./schema.js";

export interface DagNodeRow {
  id: string;
  key: string;
  role: string;
  status: string;
  title: string;
  description: string;
  subBudget: string;
  expertType: string;
  deliveryDeadline: string;
  skillTags: string[];
  dependsOn: string[];
}

export interface DagRow {
  id: string;
  requesterAddress: string;
  title: string;
  category: string;
  status: string;
  createdAt: string;
  nodes: DagNodeRow[];
}

/**
 * Persists a DAG + its nodes/edges in one transaction — topology
 * validation (topology.ts) and the sub-budget-sum-vs-declared-total check
 * (service.ts) both run BEFORE this is called, so this function trusts its
 * input is already structurally valid and only has to worry about DB-layer
 * atomicity: a partial insert (DAG row created, some nodes/edges missing)
 * would leave a DRAFT DAG a caller could `activate` against an incomplete
 * topology.
 *
 * `input.nodes[].key` is a client-scoped identifier that never reaches the
 * database (schema.ts's own doc comment) — this function's first job is
 * resolving each `key` to the real UUID `task_dag_nodes` assigns on
 * insert, so `dependsOn`/edge rows can reference real ids.
 */
export async function insertDag(
  pool: Pool,
  requesterAddress: string,
  input: CreateDagInput,
): Promise<DagRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: dagRows } = await client.query<{
      id: string;
      requester_address: string;
      title: string;
      category: string;
      status: string;
      created_at: string;
    }>(
      `INSERT INTO task_dags (requester_address, title, category) VALUES ($1, $2, $3)
         RETURNING id, requester_address, title, category, status, created_at`,
      [requesterAddress, input.title, input.category],
    );
    const dagRow = dagRows[0];
    if (!dagRow) throw new Error("insertDag: INSERT ... RETURNING produced no row for task_dags");

    // key -> real UUID, populated as each node is inserted; dependsOn
    // resolution (and therefore edge insertion) happens in a second pass
    // once every node has a real id, since a node can depend on a node
    // that appears later in the submitted array.
    const keyToId = new Map<string, string>();
    const nodeRows: DagNodeRow[] = [];

    for (const node of input.nodes) {
      const { rows } = await client.query<{
        id: string;
        node_role: string;
        node_status: string;
        title: string;
        description: string;
        sub_budget: string;
        expert_type: string;
        delivery_deadline: string;
      }>(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description, title, delivery_deadline)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, node_role, node_status, sub_budget, expert_type, description, title, delivery_deadline`,
        [
          dagRow.id,
          node.role,
          node.subBudget,
          node.expertType,
          node.description,
          node.title,
          node.deliveryDeadline,
        ],
      );
      const nodeRow = rows[0];
      if (!nodeRow) throw new Error("insertDag: INSERT ... RETURNING produced no row for a node");
      keyToId.set(node.key, nodeRow.id);

      for (const skillTag of node.skillTags) {
        await client.query(
          `INSERT INTO task_dag_node_skills (node_id, skill_tag) VALUES ($1, $2)`,
          [nodeRow.id, skillTag],
        );
      }

      nodeRows.push({
        id: nodeRow.id,
        key: node.key,
        role: nodeRow.node_role,
        status: nodeRow.node_status,
        title: nodeRow.title,
        description: nodeRow.description,
        subBudget: nodeRow.sub_budget,
        expertType: nodeRow.expert_type,
        deliveryDeadline: nodeRow.delivery_deadline,
        skillTags: node.skillTags,
        dependsOn: node.dependsOn,
      });
    }

    for (const node of input.nodes) {
      const toId = keyToId.get(node.key);
      if (!toId) throw new Error(`insertDag: no persisted id for node key "${node.key}"`);
      for (const depKey of node.dependsOn) {
        const fromId = keyToId.get(depKey);
        if (!fromId) throw new Error(`insertDag: no persisted id for dependency key "${depKey}"`);
        await client.query(
          `INSERT INTO task_dag_edges (dag_id, from_node_id, to_node_id) VALUES ($1, $2, $3)`,
          [dagRow.id, fromId, toId],
        );
      }
    }

    await client.query("COMMIT");
    return {
      id: dagRow.id,
      requesterAddress: dagRow.requester_address,
      title: dagRow.title,
      category: dagRow.category,
      status: dagRow.status,
      createdAt: dagRow.created_at,
      nodes: nodeRows,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ActivateDagOutcome =
  | { outcome: "activated"; activatedTasks: ActivatedTask[] }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "not_draft"; currentStatus: string }
  | { outcome: "nothing_ready" }
  | { outcome: "node_deadline_expired"; nodeIds: string[] }
  | { outcome: "node_missing_activation_fields"; nodeIds: string[] };

interface ReadyNodeRow {
  id: string;
  title: string | null;
  description: string | null;
  sub_budget: string;
  expert_type: string;
  delivery_deadline: Date | null;
}

/**
 * Everything `service.ts` needs, per newly-activated node, to trigger
 * `embeddings/embed-on-save.ts`'s `embedTaskOnSave` AFTER this
 * transaction commits (N4 real finding: a DAG-activated task's real
 * `tasks` row was created via a direct INSERT here — same shape as
 * tasks/routes.ts's own `POST /tasks/drafts`/`PATCH .../draft`, which
 * both fire `embedTaskOnSave` right after their own INSERT/UPDATE — but
 * this path never did, silently leaving DAG-originated tasks out of
 * `task_embeddings`-backed recall/matching (Feature 13). Fire-and-forget
 * embedding calls belong in the SAME place tasks/routes.ts already puts
 * them — outside the DB transaction, in the caller that owns the
 * request/tick lifecycle — not inside this repository function, so this
 * type exists purely to hand back what that caller needs without a
 * second round-trip query).
 */
export interface ActivatedTask {
  nodeId: string;
  taskId: string;
  description: string;
  expertType: string;
  category: string;
  skillTags: string[];
}

type FindReadyNodesResult =
  | { ok: true; rows: ReadyNodeRow[] }
  | { ok: false; outcome: "nothing_ready" }
  | { ok: false; outcome: "node_deadline_expired"; nodeIds: string[] }
  | { ok: false; outcome: "node_missing_activation_fields"; nodeIds: string[] };

/**
 * Finds every node in `dagId` that is currently activatable — `PENDING`,
 * no `task_id` yet, and (T-1703's generalization of T-1702's original
 * "zero preconditions" rule) every predecessor edge's source node is
 * already `DONE`. For a node with NO predecessors at all, "every
 * predecessor is DONE" is vacuously true — the exact same set T-1702's
 * original `POST /dags/:dagId/activate` call already needed on a freshly
 * created DRAFT DAG, where no node has reached DONE yet. This one query
 * therefore correctly serves BOTH T-1702's initial activation (called
 * once, right after DAG creation) and T-1703's node-state-advancement
 * (called repeatedly as underlying tasks complete) — no separate
 * "zero-precondition" query needed for the first case.
 *
 * MUST be called with an already-open, already-locked (`SELECT ... FOR
 * UPDATE` on `task_dags`) transaction's `client` — see `activateDag`/
 * `advanceDagNodes`'s own doc comments for why the lock has to cover this
 * read.
 */
async function findReadyNodes(client: PoolClient, dagId: string): Promise<FindReadyNodesResult> {
  const { rows } = await client.query<
    ReadyNodeRow & { missing_activation_fields: boolean; deadline_has_passed: boolean }
  >(
    `SELECT
       n.id, n.title, n.description, n.sub_budget, n.expert_type, n.delivery_deadline,
       (n.title IS NULL OR n.description IS NULL OR n.delivery_deadline IS NULL) AS missing_activation_fields,
       (n.delivery_deadline IS NOT NULL AND n.delivery_deadline <= now()) AS deadline_has_passed
     FROM task_dag_nodes n
     WHERE n.dag_id = $1
       AND n.task_id IS NULL
       AND n.node_status = 'PENDING'
       AND NOT EXISTS (
         SELECT 1 FROM task_dag_edges e
         JOIN task_dag_nodes p ON p.id = e.from_node_id
         WHERE e.dag_id = n.dag_id AND e.to_node_id = n.id AND p.node_status <> 'DONE'
       )`,
    [dagId],
  );
  if (rows.length === 0) return { ok: false, outcome: "nothing_ready" };

  // N4 real finding (round 2, T-1702, extended in T-1704 round 2 to cover
  // `description` too — 0025_make_task_dag_node_description_nullable.sql):
  // title/description/delivery_deadline are all NULLABLE specifically so a
  // node that predates the migration that made each one required (no real
  // value ever supplied) is structurally distinguishable from a real one —
  // this check is that distinction's only consumer. Checked BEFORE the
  // deadline check below (a null deadline would otherwise just silently
  // fail the "has this passed" comparison rather than being surfaced as
  // its own, more fundamental problem).
  const missingFieldsNodeIds = rows
    .filter((row) => row.missing_activation_fields)
    .map((row) => row.id);
  if (missingFieldsNodeIds.length > 0) {
    return { ok: false, outcome: "node_missing_activation_fields", nodeIds: missingFieldsNodeIds };
  }

  const expiredNodeIds = rows.filter((row) => row.deadline_has_passed).map((row) => row.id);
  if (expiredNodeIds.length > 0) {
    return { ok: false, outcome: "node_deadline_expired", nodeIds: expiredNodeIds };
  }

  return { ok: true, rows };
}

/**
 * Creates a real `tasks` DRAFT row for each given ready node and links it
 * back via `task_dag_nodes.task_id`/`node_status = 'TASK_ACTIVE'`. Caller
 * (`activateDag`/`advanceDagNodes`) owns the transaction and the `dagId`
 * row lock — this function just does the writes.
 *
 * Deliberately does NOT call tasks/repository.ts's `insertTaskDraft`
 * (which opens its own connection + transaction) — nesting a second
 * BEGIN/COMMIT inside the caller's already-open, locked transaction would
 * break the atomicity (and the lock) that transaction exists to provide.
 * The INSERT below intentionally duplicates `insertTaskDraft`'s column
 * list (matches its shape 1:1) rather than refactoring that function to
 * accept an externally-managed client — a small, contained duplication,
 * consistent with how this project already treats "same INSERT shape
 * appearing in more than one deliberately-independent transaction
 * boundary" elsewhere (e.g. every `*.integration.test.ts` file's own copy
 * of `DROP_ALL_TABLES_SQL`).
 */
async function createTasksForReadyNodes(
  client: PoolClient,
  requesterAddress: string,
  category: string,
  token: string,
  readyRows: ReadyNodeRow[],
): Promise<ActivatedTask[]> {
  const { rows: skillRows } = await client.query<{ node_id: string; skill_tag: string }>(
    `SELECT node_id, skill_tag FROM task_dag_node_skills WHERE node_id = ANY($1::uuid[])`,
    [readyRows.map((row) => row.id)],
  );
  const skillsByNode = new Map<string, string[]>();
  for (const row of skillRows) {
    const list = skillsByNode.get(row.node_id) ?? [];
    list.push(row.skill_tag);
    skillsByNode.set(row.node_id, list);
  }

  const activatedTasks: ActivatedTask[] = [];
  for (const node of readyRows) {
    // Guaranteed non-null by findReadyNodes's own missing-fields check
    // (which already returned before this function is ever called) —
    // re-checked here per-row (rather than a non-null assertion, which
    // this project's lint rules forbid) purely to keep the INSERT below's
    // parameter types honest.
    if (node.title === null || node.description === null || node.delivery_deadline === null) {
      throw new Error(
        `createTasksForReadyNodes: node ${node.id} unexpectedly missing title/description/delivery_deadline`,
      );
    }
    const { rows: taskRows } = await client.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8)
       RETURNING id`,
      [
        requesterAddress,
        category,
        node.title,
        node.description,
        node.sub_budget,
        token,
        node.delivery_deadline,
        node.expert_type,
      ],
    );
    const taskRow = taskRows[0];
    if (!taskRow)
      throw new Error("createTasksForReadyNodes: INSERT ... RETURNING produced no task row");

    for (const skillTag of skillsByNode.get(node.id) ?? []) {
      await client.query(`INSERT INTO task_skills (task_id, skill_tag) VALUES ($1, $2)`, [
        taskRow.id,
        skillTag,
      ]);
    }

    await client.query(
      `UPDATE task_dag_nodes SET task_id = $1, node_status = 'TASK_ACTIVE' WHERE id = $2`,
      [taskRow.id, node.id],
    );
    activatedTasks.push({
      nodeId: node.id,
      taskId: taskRow.id,
      description: node.description,
      expertType: node.expert_type,
      category,
      skillTags: skillsByNode.get(node.id) ?? [],
    });
  }

  return activatedTasks;
}

/**
 * Locks the DAG row, re-validates ownership/status/readiness/deadlines
 * UNDER that lock, then creates real `tasks` DRAFT rows for every
 * currently-ready node and marks the DAG `ACTIVE` — all in one
 * transaction. Mirrors tasks/repository.ts's own established
 * `lockTaskForTransition`/`transitionTaskStatus` pattern ("lock, then
 * check before writing," and any business precondition — here, the
 * deadline check — must run inside that same lock to be TOCTOU-free, see
 * that function's own doc comment) rather than inventing a second
 * convention for the same problem.
 *
 * N4 real finding (round 1): the previous version read the DAG (via a
 * separate, unlocked pre-fetch) BEFORE opening this transaction, so two
 * concurrent `POST /dags/:dagId/activate` calls could both observe
 * `DRAFT`, both create tasks for the same ready nodes, and the second
 * `UPDATE task_dag_nodes` would silently clobber the first's `task_id` —
 * leaving an orphan duplicate task no node points to, with real budget
 * committed to it. Fixed by moving the read, the status/ownership check,
 * AND the readiness computation all inside this function's own `SELECT
 * ... FOR UPDATE`-locked transaction: a second concurrent call now blocks
 * on the lock until the first commits, then sees `status = 'ACTIVE'` and
 * correctly returns `not_draft` — it can never see the pre-activation
 * ready-node set a second time.
 *
 * N4 real finding (round 1): a node's `delivery_deadline` is fixed at DAG
 * creation time (0024's own design decision — an absolute point in time,
 * not relative to activation), but a DAG can sit in DRAFT indefinitely
 * before the requester activates it, so that deadline can have already
 * passed by activation time — see `findReadyNodes`'s own deadline check,
 * which this function relies on.
 */
export async function activateDag(
  pool: Pool,
  dagId: string,
  requesterAddress: string,
  token: string,
): Promise<ActivateDagOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: dagRows } = await client.query<{
      requester_address: string;
      category: string;
      status: string;
    }>(`SELECT requester_address, category, status FROM task_dags WHERE id = $1 FOR UPDATE`, [
      dagId,
    ]);
    const dagRow = dagRows[0];
    if (!dagRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (dagRow.requester_address !== requesterAddress) {
      await client.query("ROLLBACK");
      return { outcome: "forbidden" };
    }
    if (dagRow.status !== "DRAFT") {
      await client.query("ROLLBACK");
      return { outcome: "not_draft", currentStatus: dagRow.status };
    }

    const ready = await findReadyNodes(client, dagId);
    if (!ready.ok) {
      await client.query("ROLLBACK");
      return ready;
    }

    const activatedTasks = await createTasksForReadyNodes(
      client,
      requesterAddress,
      dagRow.category,
      token,
      ready.rows,
    );

    await client.query(`UPDATE task_dags SET status = 'ACTIVE' WHERE id = $1`, [dagId]);

    await client.query("COMMIT");
    return { outcome: "activated", activatedTasks };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface AdvanceDagBlocked {
  reason: "node_deadline_expired" | "node_missing_activation_fields";
  nodeIds: string[];
}

export type AdvanceDagOutcome =
  | {
      outcome: "advanced";
      /** Nodes whose underlying task reached a terminal status this call
       * observed for the first time (node_status synced to DONE/FAILED). */
      syncedNodeIds: string[];
      /** T-1704: nodes whose overdue Agent (a real `DeliveryTimeoutClaimed`
       * event, not a dispute-driven REFUND) got a brand-new real task with
       * a freshly-computed deadline this tick — see this function's own
       * "T-1704" comment for the full design. These nodes stay TASK_ACTIVE
       * throughout — never visibly synced to FAILED — so they do NOT also
       * appear in `syncedNodeIds`. */
      rematchedNodeIds: string[];
      /** Newly-activated nodes — real `tasks` rows just created because all
       * of their preconditions are now DONE. */
      activatedTasks: ActivatedTask[];
      /** True iff this call also transitioned the DAG ACTIVE->COMPLETED
       * because every node has now reached a terminal state (DONE or
       * FAILED) — see this function's own "N4 round 2, P1" note below. */
      dagCompleted: boolean;
      /** N4 real finding (round 2, P2): set when this tick found ready
       * nodes but could NOT activate them (deadline expired / missing
       * fields). `syncedNodeIds`/`dagCompleted` above are still real,
       * committed progress from the SAME tick — a blocked downstream node
       * no longer erases an upstream node's already-real DONE sync. */
      blocked?: AdvanceDagBlocked;
    }
  | { outcome: "not_found" }
  | { outcome: "not_active"; currentStatus: string };

/**
 * F-1701/design.md 接口契约 (T-1703): "监听节点关联任务的状态变化...当某节点
 * DONE 时检查其后继节点是否全部前置已满足，满足则创建后继节点的链上任务。"
 * Feature 18 (the real event-notification mechanism this should eventually
 * run from) doesn't exist yet — per tasks.md's own risk note, this is the
 * "临时同步轮询" stand-in: `dag-poller.ts`'s real background loop is the
 * production caller (see that file's own doc comment).
 *
 * Three phases, same lock, same transaction — ALL committed together, even
 * when phase 2 can't fully complete (N4 round 2, P2 fix, see below):
 * 1. Sync: any node still `TASK_ACTIVE` whose underlying `tasks.status` has
 *    reached a terminal state gets its `node_status` updated — `RELEASED`
 *    (Feature 10's successful-settlement terminal state) means the node's
 *    real output exists, so downstream nodes may depend on it: `DONE`.
 *    `REFUNDED`/`CANCELLED` (Feature 10's non-completion terminal states —
 *    no real deliverable ever existed) means downstream nodes must NOT be
 *    unblocked by it: `FAILED`. Nothing here decides what happens to a
 *    `FAILED` node's own DAG — retry/cancel/manual-takeover is T-1705's
 *    endpoint, not this function's job.
 * 2. Activate: re-runs `findReadyNodes`/`createTasksForReadyNodes` — the
 *    exact same readiness query `activateDag` uses, which (see that
 *    function's own doc comment) already generalizes to "every
 *    predecessor is DONE," so nodes that just became includable because
 *    of THIS call's own sync step in phase 1 are picked up in the same
 *    transaction, not a subsequent call.
 *
 *    N4 real finding (round 2, P2): the previous version ROLLED BACK the
 *    entire transaction — including phase 1's real DONE/FAILED sync —
 *    whenever phase 2 found a ready-but-unactivatable node (expired
 *    deadline / missing fields). That silently discarded an upstream
 *    node's genuine completion on every tick a downstream problem
 *    existed, and the DAG kept reporting that upstream node as still
 *    `TASK_ACTIVE` forever. Fixed: phase 2's failure is now captured as
 *    `blocked` and returned alongside phase 1's real, committed sync.
 * 3. Complete: N4 real finding (round 2, P1) — nothing in this codebase
 *    ever transitioned a DAG to `COMPLETED`, so a fully-finished DAG
 *    (every node DONE/FAILED, nothing left `PENDING`/`READY`/
 *    `TASK_ACTIVE`) stayed `ACTIVE` forever and kept being re-polled by
 *    `dag-poller.ts` every tick indefinitely. A DAG with some `FAILED`
 *    nodes still becomes `COMPLETED` here — `task_dags.status`
 *    (0021_create_task_dags.sql) has no finer-grained "partially failed"
 *    state, and "this DAG's own execution has terminated" is
 *    `COMPLETED`'s only honest meaning given that enum; surfacing WHICH
 *    nodes failed is T-1707's read-view responsibility, not this
 *    function's.
 */
export async function advanceDagNodes(
  pool: Pool,
  dagId: string,
  token: string,
): Promise<AdvanceDagOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: dagRows } = await client.query<{
      requester_address: string;
      category: string;
      status: string;
    }>(`SELECT requester_address, category, status FROM task_dags WHERE id = $1 FOR UPDATE`, [
      dagId,
    ]);
    const dagRow = dagRows[0];
    if (!dagRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (dagRow.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { outcome: "not_active", currentStatus: dagRow.status };
    }

    // T-1704 (F-1703/AC-1703): "某节点的已分配 Agent 逾期...该节点可以重新触发
    // 匹配，不影响 DAG 中其他节点". Runs BEFORE the generic terminal-status
    // sync below, on purpose: a rematched node's `task_id` gets pointed at
    // the brand-new (DRAFT) task right here, so by the time the sync query
    // runs its `n.task_id = t.id` join no longer resolves to the old
    // REFUNDED task for that node — it's naturally excluded from being
    // marked FAILED, with no separate bookkeeping needed to track "already
    // rematched this tick."
    //
    // N4 real finding (round 1) — TWO real bugs in the first version, both
    // fixed here:
    //
    // 1. REFUNDED alone does not mean "Agent went overdue" — Feature 10's
    //    `resolveDispute` also produces REFUNDED when a dispute resolves in
    //    the REQUESTER's favor (tasks/service.ts's DISPUTE_RESOLVED_SUPPORT_
    //    REQUESTER path), a completely different scenario this Feature's
    //    "Agent 逾期" language was never meant to cover — auto-rematching a
    //    task a human arbitrator just ruled against the agent would be
    //    wrong. Fixed by joining `chain_events` and requiring the REAL
    //    on-chain event that produced this REFUNDED status to be
    //    `DeliveryTimeoutClaimed` (Feature 10's own settlement-kind ->
    //    event-name mapping, `planForSettlementKind` in tasks/service.ts) —
    //    the actual recorded cause, not an inference.
    //
    // 2. The first version reused the node's OWN already-stored
    //    `delivery_deadline` for the replacement task, and skipped rematch
    //    entirely once that value was `<= now()`. This is backwards: a real
    //    `DeliveryTimeoutClaimed` event can ONLY be claimed AFTER
    //    `delivery_deadline` has passed (that is the entire precondition
    //    for calling it) — so for every genuine overdue case, the stored
    //    deadline is ALWAYS already in the past by the time this function
    //    ever sees a REFUNDED row from that cause, and the old check would
    //    have silently refused every real rematch. Fixed by computing a
    //    genuinely new deadline for the replacement task instead of
    //    reusing the stale one: `now() + (old node deadline - old task's
    //    created_at)` — the SAME duration the original attempt was granted,
    //    restarted from now, rather than an arbitrary invented constant.
    //    `task_dag_nodes.delivery_deadline` is updated to this new value
    //    too (below), so a LATER rematch of the same node computes its own
    //    duration from the most recently granted deadline, not the
    //    original one.
    //
    // N4 real finding (P2, T-1706 review): this query had no `title IS NOT
    // NULL AND description IS NOT NULL` filter, but 0025 (T-1704) made
    // `description` nullable for legacy pre-migration nodes (0024 already
    // did the same for `title`). A legacy `TASK_ACTIVE` node with a NULL
    // description that later went overdue would match this query, then
    // `createTasksForReadyNodes`'s own missing-field check would `throw`
    // (not return a graceful outcome) — propagating out of this function's
    // try/catch as an unhandled rejection that rolls back the ENTIRE
    // advancement transaction, including phase 1's real, already-decided
    // sync work, and repeats identically on every subsequent poller tick
    // for that DAG. Fixed by excluding such nodes from automatic rematch
    // (same "make illegal states structurally impossible to reach" pattern
    // `activateDag`'s `node_missing_activation_fields` check already
    // established) — the node still correctly becomes `FAILED` via the
    // terminal-sync phase below (that query has no such field dependency),
    // it simply isn't a rematch candidate; a legacy node in this state
    // also can't be retried via T-1705's `retryDagNode` (same missing-field
    // check there) — a real, honest dead end for pre-0025 data, not a
    // crash.
    const { rows: rematchCandidateRows } = await client.query<{
      id: string;
      title: string | null;
      description: string;
      sub_budget: string;
      expert_type: string;
      new_delivery_deadline: Date;
    }>(
      `SELECT
         n.id, n.title, n.description, n.sub_budget, n.expert_type,
         now() + (n.delivery_deadline - t.created_at) AS new_delivery_deadline
       FROM task_dag_nodes n
       JOIN tasks t ON t.id = n.task_id
       WHERE n.dag_id = $1
         AND n.node_status = 'TASK_ACTIVE'
         AND t.status = 'REFUNDED'
         AND n.delivery_deadline IS NOT NULL
         AND n.title IS NOT NULL
         AND n.description IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM chain_events ce
           WHERE ce.task_id = t.id AND ce.event_name = 'DeliveryTimeoutClaimed'
         )`,
      [dagId],
    );
    const rematchableRows: ReadyNodeRow[] = rematchCandidateRows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      sub_budget: row.sub_budget,
      expert_type: row.expert_type,
      delivery_deadline: row.new_delivery_deadline,
    }));
    const rematchedTasks =
      rematchableRows.length > 0
        ? await createTasksForReadyNodes(
            client,
            dagRow.requester_address,
            dagRow.category,
            token,
            rematchableRows,
          )
        : [];
    if (rematchableRows.length > 0) {
      // Keeps task_dag_nodes.delivery_deadline in sync with the new real
      // task's own deadline — see the "genuinely new deadline" note above
      // for why a later rematch must compute its duration from this
      // updated value, not the original (now-superseded) one.
      await client.query(
        `UPDATE task_dag_nodes SET delivery_deadline = new_deadlines.new_delivery_deadline
           FROM (VALUES ${rematchableRows.map((_row, index) => `($${index * 2 + 1}::uuid, $${index * 2 + 2}::timestamptz)`).join(", ")}) AS new_deadlines(node_id, new_delivery_deadline)
           WHERE task_dag_nodes.id = new_deadlines.node_id`,
        rematchableRows.flatMap((row) => [row.id, row.delivery_deadline]),
      );
    }

    const { rows: syncedRows } = await client.query<{ id: string }>(
      `UPDATE task_dag_nodes n
         SET node_status = CASE t.status
           WHEN 'RELEASED' THEN 'DONE'
           WHEN 'REFUNDED' THEN 'FAILED'
           WHEN 'CANCELLED' THEN 'FAILED'
           ELSE n.node_status
         END
         FROM tasks t
         WHERE n.task_id = t.id
           AND n.dag_id = $1
           AND n.node_status = 'TASK_ACTIVE'
           AND t.status IN ('RELEASED', 'REFUNDED', 'CANCELLED')
         RETURNING n.id`,
      [dagId],
    );

    const ready = await findReadyNodes(client, dagId);
    // Starts with `rematchedTasks` (T-1704) — a rematched node also got a
    // brand-new real `tasks` row this tick and needs the same post-commit
    // `embedTaskOnSave` trigger (service.ts) as a freshly-activated one.
    let activatedTasks: ActivatedTask[] = [...rematchedTasks];
    let blocked: AdvanceDagBlocked | undefined;
    if (ready.ok) {
      activatedTasks = activatedTasks.concat(
        await createTasksForReadyNodes(
          client,
          dagRow.requester_address,
          dagRow.category,
          token,
          ready.rows,
        ),
      );
    } else if (ready.outcome !== "nothing_ready") {
      blocked = { reason: ready.outcome, nodeIds: ready.nodeIds };
    }

    const { rows: unfinishedRows } = await client.query<{ id: string }>(
      `SELECT id FROM task_dag_nodes WHERE dag_id = $1 AND node_status NOT IN ('DONE', 'FAILED') LIMIT 1`,
      [dagId],
    );
    const dagCompleted = unfinishedRows.length === 0;
    if (dagCompleted) {
      await client.query(`UPDATE task_dags SET status = 'COMPLETED' WHERE id = $1`, [dagId]);
    }

    await client.query("COMMIT");
    return {
      outcome: "advanced",
      syncedNodeIds: syncedRows.map((row) => row.id),
      rematchedNodeIds: rematchedTasks.map((task) => task.nodeId),
      activatedTasks,
      dagCompleted,
      ...(blocked ? { blocked } : {}),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// T-1705: node-level control (retry/cancel/manual-takeover)
// ---------------------------------------------------------------------

export type WithLockedActiveDagNodeOutcome<T> =
  | { outcome: "dag_not_found" }
  | { outcome: "forbidden" }
  | { outcome: "node_not_found" }
  | { outcome: "node_not_active" }
  | { outcome: "ran"; result: T };

/**
 * T-1705's eligibility gate for `cancelDagNode` (service.ts) — locks the
 * DAG row, then the node row (`SELECT ... FOR UPDATE`, same lock ORDER
 * `manualTakeoverDagNode` uses — dag row first, then node row — so the two
 * can never deadlock against each other), verifies ownership + `node_status
 * = 'TASK_ACTIVE'`, then COMMITS (releasing the lock) BEFORE invoking `fn`
 * (which calls `tasks/service.ts`'s `verifyCancellation`).
 *
 * N4 real finding (round 2, T-1707 review) — this function's own PREVIOUS
 * version held the lock across the entire `fn` call instead of releasing
 * it first. That version was itself the round-1 fix for a real race (see
 * below), but introduced a WORSE, strictly more dangerous problem: `fn`
 * calls `verifyCancellation`, which acquires its OWN client from this same
 * `pool` — while this function's own client is still checked out and
 * holding the transaction. Under a small pool (or enough concurrent
 * cancellations to exhaust it), every in-flight call ends up holding its
 * OUTER connection while waiting for an INNER connection from the same
 * exhausted pool — a real, reproducible pool-level deadlock that stalls
 * the cancel endpoint AND every other request sharing the pool, not just
 * this one code path. A total-availability risk is strictly worse than
 * the narrower problem it was fixing, so this function now releases the
 * lock before `fn` runs.
 *
 * This DOES reopen a window narrower than "permanent, DAG-wide dead end":
 * a concurrent `manualTakeoverDagNode` call could still commit
 * `MANUAL_TAKEOVER` between this function's `COMMIT` and `verifyCancellation`
 * completing, leaving a node whose task really did get cancelled on-chain
 * stuck at `MANUAL_TAKEOVER` instead of syncing to `FAILED`. But
 * `MANUAL_TAKEOVER` having no "resume automatic sync" path is ALREADY a
 * documented, accepted scope gap for T-1705 in general (see
 * `manualTakeoverDagNode`'s own doc comment: "resuming/un-pausing is
 * explicitly out of this Task's scope") — a paused node staying paused
 * regardless of what its underlying task does next is consistent with
 * that same accepted gap, not a new failure mode this function
 * introduces. Requires the requester to race two of their OWN requests
 * against each other within the same short window to even trigger it.
 */
export async function withLockedActiveDagNode<T>(
  pool: Pool,
  dagId: string,
  nodeId: string,
  requesterAddress: string,
  fn: (taskId: string) => Promise<T>,
): Promise<WithLockedActiveDagNodeOutcome<T>> {
  const client = await pool.connect();
  let taskId: string;
  try {
    await client.query("BEGIN");

    const { rows: dagRows } = await client.query<{ requester_address: string }>(
      `SELECT requester_address FROM task_dags WHERE id = $1 FOR UPDATE`,
      [dagId],
    );
    const dagRow = dagRows[0];
    if (!dagRow) {
      await client.query("ROLLBACK");
      return { outcome: "dag_not_found" };
    }
    if (dagRow.requester_address !== requesterAddress) {
      await client.query("ROLLBACK");
      return { outcome: "forbidden" };
    }

    const { rows: nodeRows } = await client.query<{ task_id: string | null; node_status: string }>(
      `SELECT task_id, node_status FROM task_dag_nodes WHERE dag_id = $1 AND id = $2 FOR UPDATE`,
      [dagId, nodeId],
    );
    const nodeRow = nodeRows[0];
    if (!nodeRow) {
      await client.query("ROLLBACK");
      return { outcome: "node_not_found" };
    }
    if (!nodeRow.task_id || nodeRow.node_status !== "TASK_ACTIVE") {
      await client.query("ROLLBACK");
      return { outcome: "node_not_active" };
    }

    taskId = nodeRow.task_id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // The lock is already released (client returned to the pool above) —
  // `fn` is free to acquire its own connection from `pool` without risking
  // the deadlock this function's doc comment describes.
  const result = await fn(taskId);
  return { outcome: "ran", result };
}

export type RetryDagNodeOutcome =
  | { outcome: "retried"; activatedTask: ActivatedTask }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "not_retryable"; currentStatus: string }
  | { outcome: "dag_not_retryable"; currentStatus: string };

/**
 * F-1705 "重试（重新匹配+重新执行）": creates a brand-new real `tasks` DRAFT
 * row for a node whose previous attempt ended in terminal failure
 * (`node_status = 'FAILED'`, which `advanceDagNodes`' own terminal-sync
 * phase only ever sets from a task that reached `REFUNDED`/`CANCELLED`),
 * and points the node back at it (`TASK_ACTIVE`) — deliberately reuses
 * `createTasksForReadyNodes` (design knowledge for "how a DAG node's task
 * row gets created" has exactly one owner) and the exact same
 * "preserve the originally-granted duration" deadline formula T-1704's
 * automatic rematch phase already established (`now() + (old node deadline
 * - old task's created_at)`), rather than inventing a second, parallel
 * "create a task for this node" implementation or a second deadline rule.
 *
 * Unlike T-1704's automatic rematch (gated on a real `DeliveryTimeoutClaimed`
 * chain event — "the agent went overdue"), this is an explicit,
 * requester-initiated retry with NO cause restriction: any terminally-failed
 * node (timeout, dispute lost, or a manually cancelled task) is eligible —
 * F-1705's own wording ("重试...不限定原因") only ties retry to
 * `node_status = 'FAILED'`, not to a specific chain event, which is exactly
 * the distinction that makes this a separate function rather than a call
 * site reusing the rematch query as-is (that query's `DeliveryTimeoutClaimed`
 * join is Its own eligibility rule, not a general "terminal failure" test).
 *
 * N4 real finding (P1): a DAG that already reached `COMPLETED` (every node
 * DONE/FAILED — `advanceDagNodes`' own completion phase) is no longer
 * returned by `listActiveDagIds`, so `dag-poller.ts` stops polling it. The
 * original version of this function let a `FAILED` node in such a DAG be
 * retried anyway — a brand-new real `tasks` row would be created and
 * pointed at, but with the DAG still `COMPLETED`, nothing would ever poll
 * that new task's terminal status again, silently stranding it forever.
 * Fixed: retry is only allowed while the DAG is `ACTIVE` or `COMPLETED`
 * (`DRAFT`/`CANCELLED` refused — a DAG that was never activated or was
 * itself cancelled has no business creating new real tasks), and a
 * successful retry against a `COMPLETED` DAG atomically restores it to
 * `ACTIVE` in the SAME transaction, so the very next poller tick picks the
 * DAG back up.
 */
export async function retryDagNode(
  pool: Pool,
  dagId: string,
  nodeId: string,
  requesterAddress: string,
  token: string,
): Promise<RetryDagNodeOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: dagRows } = await client.query<{
      requester_address: string;
      category: string;
      status: string;
    }>(`SELECT requester_address, category, status FROM task_dags WHERE id = $1 FOR UPDATE`, [
      dagId,
    ]);
    const dagRow = dagRows[0];
    if (!dagRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (dagRow.requester_address !== requesterAddress) {
      await client.query("ROLLBACK");
      return { outcome: "forbidden" };
    }
    if (dagRow.status !== "ACTIVE" && dagRow.status !== "COMPLETED") {
      await client.query("ROLLBACK");
      return { outcome: "dag_not_retryable", currentStatus: dagRow.status };
    }

    const { rows: nodeRows } = await client.query<{
      id: string;
      title: string | null;
      description: string | null;
      sub_budget: string;
      expert_type: string;
      node_status: string;
      task_id: string | null;
      new_delivery_deadline: Date | null;
    }>(
      `SELECT n.id, n.title, n.description, n.sub_budget, n.expert_type, n.node_status, n.task_id,
              (now() + (n.delivery_deadline - t.created_at)) AS new_delivery_deadline
         FROM task_dag_nodes n
         LEFT JOIN tasks t ON t.id = n.task_id AND t.status IN ('REFUNDED', 'CANCELLED')
         WHERE n.dag_id = $1 AND n.id = $2
         FOR UPDATE OF n`,
      [dagId, nodeId],
    );
    const nodeRow = nodeRows[0];
    if (!nodeRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (
      nodeRow.node_status !== "FAILED" ||
      !nodeRow.task_id ||
      nodeRow.new_delivery_deadline === null ||
      nodeRow.title === null ||
      nodeRow.description === null
    ) {
      await client.query("ROLLBACK");
      return { outcome: "not_retryable", currentStatus: nodeRow.node_status };
    }

    const readyRow: ReadyNodeRow = {
      id: nodeRow.id,
      title: nodeRow.title,
      description: nodeRow.description,
      sub_budget: nodeRow.sub_budget,
      expert_type: nodeRow.expert_type,
      delivery_deadline: nodeRow.new_delivery_deadline,
    };

    const activatedTasks = await createTasksForReadyNodes(
      client,
      requesterAddress,
      dagRow.category,
      token,
      [readyRow],
    );
    const activatedTask = activatedTasks[0];
    if (!activatedTask) {
      throw new Error(`retryDagNode: createTasksForReadyNodes produced no task for node ${nodeId}`);
    }

    // Same reasoning as T-1704's rematch phase: keeps `task_dag_nodes.
    // delivery_deadline` in sync with the new task's own deadline, so a
    // LATER retry of the same node computes its duration from this updated
    // value, not the original one.
    await client.query(`UPDATE task_dag_nodes SET delivery_deadline = $1 WHERE id = $2`, [
      readyRow.delivery_deadline,
      nodeId,
    ]);

    // See this function's own "N4 real finding (P1)" note above: a retry
    // that revives a `COMPLETED` DAG must put it back on
    // `listActiveDagIds`' radar in the SAME transaction as the new task,
    // or the new task would be created but never polled.
    if (dagRow.status === "COMPLETED") {
      await client.query(`UPDATE task_dags SET status = 'ACTIVE' WHERE id = $1`, [dagId]);
    }

    await client.query("COMMIT");
    return { outcome: "retried", activatedTask };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ManualTakeoverOutcome =
  | { outcome: "paused" }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "not_pausable"; currentStatus: string };

/**
 * F-1705 "人工接管...暂停自动流程": marks a node `MANUAL_TAKEOVER` — no chain
 * interaction, no new task, purely a DB-level pause flag. This value alone
 * is sufficient to freeze the node without any extra `WHERE node_status <>
 * 'MANUAL_TAKEOVER'` clauses elsewhere: `findReadyNodes` only ever selects
 * `node_status = 'PENDING'`, and `advanceDagNodes`' terminal-sync/rematch
 * queries only ever select `node_status = 'TASK_ACTIVE'` — a node marked
 * `MANUAL_TAKEOVER` (from either starting state) falls outside both
 * predicates automatically, and `advanceDagNodes`' own DAG-completion check
 * (`node_status NOT IN ('DONE','FAILED')`) correctly keeps the DAG `ACTIVE`
 * (not `COMPLETED`) for as long as a node stays paused — pausing this
 * function's job, resuming/un-pausing is explicitly out of this Task's
 * scope (F-1705's own wording only describes pausing).
 */
export async function manualTakeoverDagNode(
  pool: Pool,
  dagId: string,
  nodeId: string,
  requesterAddress: string,
): Promise<ManualTakeoverOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: dagRows } = await client.query<{ requester_address: string }>(
      `SELECT requester_address FROM task_dags WHERE id = $1 FOR UPDATE`,
      [dagId],
    );
    const dagRow = dagRows[0];
    if (!dagRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (dagRow.requester_address !== requesterAddress) {
      await client.query("ROLLBACK");
      return { outcome: "forbidden" };
    }

    const { rows: nodeRows } = await client.query<{ id: string; node_status: string }>(
      `SELECT id, node_status FROM task_dag_nodes WHERE dag_id = $1 AND id = $2 FOR UPDATE`,
      [dagId, nodeId],
    );
    const nodeRow = nodeRows[0];
    if (!nodeRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (nodeRow.node_status !== "PENDING" && nodeRow.node_status !== "TASK_ACTIVE") {
      await client.query("ROLLBACK");
      return { outcome: "not_pausable", currentStatus: nodeRow.node_status };
    }

    await client.query(`UPDATE task_dag_nodes SET node_status = 'MANUAL_TAKEOVER' WHERE id = $1`, [
      nodeId,
    ]);

    await client.query("COMMIT");
    return { outcome: "paused" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type SelectDagNodeResultOutcome =
  | { outcome: "selected"; selectedNodeIds: string[] }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "not_aggregate"; nodeRole: string }
  | { outcome: "invalid_selection"; invalidNodeIds: string[] };

/**
 * F-1706 "多结果择优/聚合": records which of an `AGGREGATE` node's own direct
 * predecessors the requester adopts as that node's basis. Deliberately
 * does ONLY this one `UPDATE` — no settlement, no `tasks` table write, no
 * call into `tasks/service.ts` at all. That is not an omission: AC-1704's
 * own core assertion is that an unselected-but-completed predecessor's
 * settlement must proceed entirely through its own existing
 * acceptance/timeout rules, "不因为没被选中就被判定为失败" — the only way to
 * guarantee that by construction (not by remembering not to break it
 * later) is for this function to have no code path that can reach a
 * `tasks` row at all.
 *
 * `selectedNodeIds` must each be a real predecessor edge's source node
 * (`task_dag_edges` scoped to this DAG and this node) that has already
 * reached `DONE` — selecting an in-flight or failed predecessor's
 * "result" is not meaningful (there is no real deliverable yet, or the
 * one that existed was never accepted). Re-selecting (overwriting a
 * previous selection) is allowed — this is bookkeeping metadata, not a
 * one-time irreversible action, and re-running it is naturally idempotent
 * (same `UPDATE`, same resulting array) given the same real predecessor
 * states.
 */
export async function selectDagNodeResult(
  pool: Pool,
  dagId: string,
  nodeId: string,
  requesterAddress: string,
  selectedNodeIds: string[],
): Promise<SelectDagNodeResultOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: dagRows } = await client.query<{ requester_address: string }>(
      `SELECT requester_address FROM task_dags WHERE id = $1 FOR UPDATE`,
      [dagId],
    );
    const dagRow = dagRows[0];
    if (!dagRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (dagRow.requester_address !== requesterAddress) {
      await client.query("ROLLBACK");
      return { outcome: "forbidden" };
    }

    const { rows: nodeRows } = await client.query<{ id: string; node_role: string }>(
      `SELECT id, node_role FROM task_dag_nodes WHERE dag_id = $1 AND id = $2 FOR UPDATE`,
      [dagId, nodeId],
    );
    const nodeRow = nodeRows[0];
    if (!nodeRow) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (nodeRow.node_role !== "AGGREGATE") {
      await client.query("ROLLBACK");
      return { outcome: "not_aggregate", nodeRole: nodeRow.node_role };
    }

    const { rows: validPredecessorRows } = await client.query<{ id: string }>(
      `SELECT p.id
         FROM task_dag_edges e
         JOIN task_dag_nodes p ON p.id = e.from_node_id
         WHERE e.dag_id = $1
           AND e.to_node_id = $2
           AND p.id = ANY($3::uuid[])
           AND p.node_status = 'DONE'`,
      [dagId, nodeId, selectedNodeIds],
    );
    const validIds = new Set(validPredecessorRows.map((row) => row.id));
    const invalidNodeIds = selectedNodeIds.filter((id) => !validIds.has(id));
    if (invalidNodeIds.length > 0) {
      await client.query("ROLLBACK");
      return { outcome: "invalid_selection", invalidNodeIds };
    }

    await client.query(`UPDATE task_dag_nodes SET selected_predecessor_ids = $1 WHERE id = $2`, [
      selectedNodeIds,
      nodeId,
    ]);

    await client.query("COMMIT");
    return { outcome: "selected", selectedNodeIds };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * `dag-poller.ts`'s own per-tick input — every DAG that could conceivably
 * still have work to do (`ACTIVE`: some node may have just reached a
 * terminal task status since the last tick). `DRAFT` DAGs are excluded —
 * nothing advances them, only `POST /dags/:dagId/activate` does, a
 * requester-initiated action outside this poller's scope — and so are
 * `COMPLETED`/`CANCELLED` DAGs, for the same reason.
 */
export async function listActiveDagIds(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM task_dags WHERE status = 'ACTIVE'`,
  );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------
// T-1707: GET /dags/:dagId — read-only DAG detail + budget projection
// ---------------------------------------------------------------------

export interface DagDetailNodeRow {
  id: string;
  role: string;
  nodeStatus: string;
  title: string | null;
  /** The node's own DECLARED budget at DAG-creation time — immutable,
   * never edited after `POST /dags`. Once a node has a real `taskId`, the
   * ACTUAL amount locked/refunded/released on-chain is `taskBudget`
   * (below), not this field — see that field's own doc comment for why
   * the two can diverge and which one the budget projection must use. */
  subBudget: string;
  expertType: string;
  taskId: string | null;
  /** NULL when `taskId` is NULL (node not yet activated) — see decision 1
   * (design.md): a node's real fund state is always read from its own
   * linked `tasks.status`, never duplicated onto `task_dag_nodes`. */
  taskStatus: string | null;
  /**
   * N4 real finding (P1, T-1707 review): NULL when `taskId` is NULL, else
   * the linked task's OWN CURRENT `tasks.budget` — which is NOT guaranteed
   * to equal `subBudget`. `PATCH /tasks/:taskId/draft` (Feature 6,
   * unmodified) lets a requester edit ANY `DRAFT` task's `budget`,
   * including a DAG-activated node's task (`createTasksForReadyNodes`
   * creates an ordinary `DRAFT` row — nothing marks it "DAG-owned,
   * budget-locked"). A requester could edit it before funding, then fund
   * the EDITED amount — at that point `subBudget` no longer reflects what
   * is actually locked/refunded/released on-chain for that node.
   * `aggregateDagBudget` (service.ts) must bucket by `taskBudget` whenever
   * it is non-null (a real task exists) and fall back to `subBudget` only
   * when `taskId` is NULL (nothing to read yet) — this keeps the
   * projection honest about what actually happened on-chain, per this
   * function's own "reads the real facts" design, rather than trusting a
   * value that can silently go stale.
   */
  taskBudget: string | null;
  selectedPredecessorIds: string[];
}

export interface DagDetailEdgeRow {
  fromNodeId: string;
  toNodeId: string;
}

export interface DagDetailRow {
  id: string;
  requesterAddress: string;
  title: string;
  category: string;
  status: string;
  createdAt: string;
  nodes: DagDetailNodeRow[];
  edges: DagDetailEdgeRow[];
}

/**
 * F-1707/F-1708's read side (T-1707): a single, pure projection over
 * already-existing rows — `task_dags`/`task_dag_nodes` for structure, each
 * node's own linked `tasks.status`/`tasks.budget` for its real fund state.
 * Writes NOTHING, decides NOTHING about settlement — decision 1 (design.md)
 * already established that a DAG's "budget view" is an API-layer
 * aggregation over N independent, already-proven-correct single-task fund
 * flows, not a new resource with its own accounting rules. `service.ts`'s
 * `getDagDetail` is what turns these rows into the actual budget-bucket
 * totals (`aggregateDagBudget`); this function only fetches the raw facts.
 */
export async function getDagDetail(pool: Pool, dagId: string): Promise<DagDetailRow | null> {
  const { rows: dagRows } = await pool.query<{
    id: string;
    requester_address: string;
    title: string;
    category: string;
    status: string;
    created_at: string;
  }>(
    `SELECT id, requester_address, title, category, status, created_at FROM task_dags WHERE id = $1`,
    [dagId],
  );
  const dagRow = dagRows[0];
  if (!dagRow) return null;

  const { rows: nodeRows } = await pool.query<{
    id: string;
    node_role: string;
    node_status: string;
    title: string | null;
    sub_budget: string;
    expert_type: string;
    task_id: string | null;
    task_status: string | null;
    task_budget: string | null;
    selected_predecessor_ids: string[];
  }>(
    `SELECT n.id, n.node_role, n.node_status, n.title, n.sub_budget, n.expert_type,
            n.task_id, t.status AS task_status, t.budget AS task_budget,
            n.selected_predecessor_ids
       FROM task_dag_nodes n
       LEFT JOIN tasks t ON t.id = n.task_id
       WHERE n.dag_id = $1
       ORDER BY n.created_at`,
    [dagId],
  );

  const { rows: edgeRows } = await pool.query<{ from_node_id: string; to_node_id: string }>(
    `SELECT from_node_id, to_node_id FROM task_dag_edges WHERE dag_id = $1`,
    [dagId],
  );

  return {
    id: dagRow.id,
    requesterAddress: dagRow.requester_address,
    title: dagRow.title,
    category: dagRow.category,
    status: dagRow.status,
    createdAt: dagRow.created_at,
    nodes: nodeRows.map((row) => ({
      id: row.id,
      role: row.node_role,
      nodeStatus: row.node_status,
      title: row.title,
      subBudget: row.sub_budget,
      expertType: row.expert_type,
      taskId: row.task_id,
      taskStatus: row.task_status,
      taskBudget: row.task_budget,
      selectedPredecessorIds: row.selected_predecessor_ids,
    })),
    edges: edgeRows.map((row) => ({ fromNodeId: row.from_node_id, toNodeId: row.to_node_id })),
  };
}
