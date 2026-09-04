import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 17 (multi-agent-dag-orchestration), T-1700 —
 * 0021_create_task_dags.sql's own real-Postgres verification. See
 * migrate.integration.test.ts's header comment: skipped unless
 * RUN_DB_INTEGRATION_TESTS=1 against a confirmed throwaway
 * TEST_DATABASE_URL.
 *
 * T-1700's own verification checklist (tasks.md): "迁移可重复执行；FK/CHECK
 * 约束覆盖设计中的状态值域". Beyond the enum/format checks every other
 * migration in this repo already establishes a pattern for, this file also
 * covers the one design decision specific to this migration (see
 * 0021_create_task_dags.sql's header comment, "design decision, option
 * B"): task_dag_edges' composite FKs must reject an edge whose endpoints
 * belong to a DIFFERENT dag_id than the edge itself, not just enforce that
 * the endpoints exist somewhere.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e90d9";

runIfOptedIn("0021_create_task_dags migration (integration, T-1700)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM task_dag_edges");
    await pool.query("DELETE FROM task_dag_nodes");
    await pool.query("DELETE FROM task_dags");
  });

  async function insertDag(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO task_dags (requester_address, title, category) VALUES ($1, 'A DAG', 'writing') RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertDag: no id returned");
    return id;
  }

  async function insertNode(dagId: string, role: string = "SERIAL"): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description, title, delivery_deadline) VALUES ($1, $2, 100, 'AUTOMATION', 'desc', 'Node', now() + interval '7 days') RETURNING id`,
      [dagId, role],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertNode: no id returned");
    return id;
  }

  it("a DAG defaults to status='DRAFT' and requester_address must be a real user address", async () => {
    const dagId = await insertDag();
    const { rows } = await pool.query<{ status: string; requester_address: string }>(
      `SELECT status, requester_address FROM task_dags WHERE id = $1`,
      [dagId],
    );
    expect(rows[0]?.status).toBe("DRAFT");
    expect(rows[0]?.requester_address).toBe(REQUESTER_ADDRESS);

    await expect(
      pool.query(
        `INSERT INTO task_dags (requester_address, title, category) VALUES ($1, 'Bad', 'writing') `,
        ["not-a-real-address"],
      ),
    ).rejects.toThrow();
  });

  it("task_dags.status rejects a value outside the four-state enum", async () => {
    await expect(
      pool.query(
        `INSERT INTO task_dags (requester_address, title, category, status) VALUES ($1, 'Bad', 'writing', 'NOT_A_REAL_STATE')`,
        [REQUESTER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("all four task_dags.status values are individually insertable", async () => {
    for (const status of ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]) {
      const { rows } = await pool.query<{ status: string }>(
        `INSERT INTO task_dags (requester_address, title, category, status) VALUES ($1, $2, 'writing', $3) RETURNING status`,
        [REQUESTER_ADDRESS, `DAG ${status}`, status],
      );
      expect(rows[0]?.status).toBe(status);
    }
  });

  it("task_dag_nodes.node_role rejects a value outside SERIAL/PARALLEL/AGGREGATE", async () => {
    const dagId = await insertDag();
    await expect(
      pool.query(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description, title, delivery_deadline) VALUES ($1, 'NOT_A_ROLE', 100, 'AUTOMATION', 'desc', 'Node', now() + interval '7 days')`,
        [dagId],
      ),
    ).rejects.toThrow();
  });

  it("task_dag_nodes.selected_predecessor_ids (T-1706, 0026) defaults to an empty array and round-trips real UUIDs", async () => {
    const dagId = await insertDag();
    const predecessorA = await insertNode(dagId, "PARALLEL");
    const predecessorB = await insertNode(dagId, "PARALLEL");
    const aggregateId = await insertNode(dagId, "AGGREGATE");

    const { rows: defaultRows } = await pool.query<{ selected_predecessor_ids: string[] }>(
      `SELECT selected_predecessor_ids FROM task_dag_nodes WHERE id = $1`,
      [aggregateId],
    );
    expect(defaultRows[0]?.selected_predecessor_ids).toEqual([]);

    await pool.query(`UPDATE task_dag_nodes SET selected_predecessor_ids = $1 WHERE id = $2`, [
      [predecessorA, predecessorB],
      aggregateId,
    ]);
    const { rows: updatedRows } = await pool.query<{ selected_predecessor_ids: string[] }>(
      `SELECT selected_predecessor_ids FROM task_dag_nodes WHERE id = $1`,
      [aggregateId],
    );
    expect(updatedRows[0]?.selected_predecessor_ids).toEqual([predecessorA, predecessorB]);
  });

  it("task_dag_nodes.node_status defaults to PENDING and rejects a value outside the six-state enum", async () => {
    const dagId = await insertDag();
    const nodeId = await insertNode(dagId);
    const { rows } = await pool.query<{ node_status: string }>(
      `SELECT node_status FROM task_dag_nodes WHERE id = $1`,
      [nodeId],
    );
    expect(rows[0]?.node_status).toBe("PENDING");

    await expect(
      pool.query(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, node_status, expert_type, description, title, delivery_deadline) VALUES ($1, 'SERIAL', 100, 'NOT_A_REAL_STATE', 'AUTOMATION', 'desc', 'Node', now() + interval '7 days')`,
        [dagId],
      ),
    ).rejects.toThrow();
  });

  it("all six task_dag_nodes.node_status values are individually insertable", async () => {
    const dagId = await insertDag();
    for (const status of ["PENDING", "READY", "TASK_ACTIVE", "DONE", "FAILED", "MANUAL_TAKEOVER"]) {
      const { rows } = await pool.query<{ node_status: string }>(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, node_status, expert_type, description, title, delivery_deadline) VALUES ($1, 'SERIAL', 100, $2, 'AUTOMATION', 'desc', 'Node', now() + interval '7 days') RETURNING node_status`,
        [dagId, status],
      );
      expect(rows[0]?.node_status).toBe(status);
    }
  });

  it("task_dag_nodes.sub_budget must be positive", async () => {
    const dagId = await insertDag();
    await expect(
      pool.query(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description, title, delivery_deadline) VALUES ($1, 'SERIAL', 0, 'AUTOMATION', 'desc', 'Node', now() + interval '7 days')`,
        [dagId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description, title, delivery_deadline) VALUES ($1, 'SERIAL', -50, 'AUTOMATION', 'desc', 'Node', now() + interval '7 days')`,
        [dagId],
      ),
    ).rejects.toThrow();
  });

  it("task_dag_nodes.task_id is unique: the same task cannot back two different nodes", async () => {
    const dagId = await insertDag();
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
         VALUES ($1, 'writing', 'T', 'd', 100, '0x0000000000000000000000000000000000000000', now() + interval '1 day', 'DRAFT', 'AUTOMATION')
         RETURNING id`,
      [REQUESTER_ADDRESS],
    );
    const taskId = taskRows[0]?.id;
    if (!taskId) throw new Error("no task id returned");

    await pool.query(
      `INSERT INTO task_dag_nodes (dag_id, task_id, node_role, sub_budget, expert_type, description, title, delivery_deadline) VALUES ($1, $2, 'SERIAL', 100, 'AUTOMATION', 'desc', 'Node', now() + interval '7 days')`,
      [dagId, taskId],
    );
    await expect(
      pool.query(
        `INSERT INTO task_dag_nodes (dag_id, task_id, node_role, sub_budget, expert_type, description, title, delivery_deadline) VALUES ($1, $2, 'SERIAL', 100, 'AUTOMATION', 'desc', 'Node', now() + interval '7 days')`,
        [dagId, taskId],
      ),
    ).rejects.toThrow();
  });

  it("multiple nodes with task_id = NULL coexist (NULL is not subject to the UNIQUE constraint)", async () => {
    const dagId = await insertDag();
    await insertNode(dagId);
    await insertNode(dagId);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM task_dag_nodes WHERE dag_id = $1 AND task_id IS NULL`,
      [dagId],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it("task_dag_nodes.expert_type rejects a value outside the five-state enum (T-1701, 0022 follow-up migration)", async () => {
    const dagId = await insertDag();
    await expect(
      pool.query(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description, title, delivery_deadline) VALUES ($1, 'SERIAL', 100, 'NOT_A_REAL_TYPE', 'desc', 'Node', now() + interval '7 days')`,
        [dagId],
      ),
    ).rejects.toThrow();
  });

  it("task_dag_nodes.expert_type is NOT NULL with no standing default (must be supplied explicitly)", async () => {
    const dagId = await insertDag();
    await expect(
      pool.query(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget) VALUES ($1, 'SERIAL', 100)`,
        [dagId],
      ),
    ).rejects.toThrow();
  });

  it(
    "task_dag_nodes.title and delivery_deadline are NULLABLE (N4 round-2 fix, 0024) — a row created " +
      "with neither (simulating a pre-0024 legacy node) is accepted at the DB layer; T-1702's " +
      "activateDag is the actual enforcement point (activate-routes.integration.test.ts), not a " +
      "NOT NULL constraint here",
    async () => {
      const dagId = await insertDag();
      const { rows } = await pool.query<{ title: string | null; delivery_deadline: Date | null }>(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description)
           VALUES ($1, 'SERIAL', 100, 'AUTOMATION', 'desc') RETURNING title, delivery_deadline`,
        [dagId],
      );
      expect(rows[0]?.title).toBeNull();
      expect(rows[0]?.delivery_deadline).toBeNull();
    },
  );

  it(
    "task_dag_nodes.description is NULLABLE (N4 round-2 fix, T-1704, 0025) — a row created with " +
      "no description is accepted at the DB layer; activation is the real enforcement point",
    async () => {
      const dagId = await insertDag();
      const { rows } = await pool.query<{ description: string | null }>(
        `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type)
           VALUES ($1, 'SERIAL', 100, 'AUTOMATION') RETURNING description`,
        [dagId],
      );
      expect(rows[0]?.description).toBeNull();
    },
  );

  it("0025's forward migration converts any pre-existing empty-string description ('') to NULL, not leaving it as an indistinguishable placeholder", async () => {
    // Simulates a row that existed under 0023's original NOT NULL DEFAULT
    // '' shape — reproduced here by relaxing the constraint, inserting the
    // literal placeholder value, then reapplying 0025's own forward SQL.
    await pool.query(`ALTER TABLE task_dag_nodes ALTER COLUMN description DROP NOT NULL`);
    const dagId = await insertDag();
    const { rows: insertedRows } = await pool.query<{ id: string }>(
      `INSERT INTO task_dag_nodes (dag_id, node_role, sub_budget, expert_type, description)
         VALUES ($1, 'SERIAL', 100, 'AUTOMATION', '') RETURNING id`,
      [dagId],
    );
    const nodeId = insertedRows[0]?.id;
    if (!nodeId) throw new Error("no id returned");

    await pool.query(`UPDATE task_dag_nodes SET description = NULL WHERE description = ''`);

    const { rows } = await pool.query<{ description: string | null }>(
      `SELECT description FROM task_dag_nodes WHERE id = $1`,
      [nodeId],
    );
    expect(rows[0]?.description).toBeNull();
  });

  it("task_dag_node_skills stores multiple skill tags per node and cascades on node delete", async () => {
    const dagId = await insertDag();
    const nodeId = await insertNode(dagId);
    await pool.query(
      `INSERT INTO task_dag_node_skills (node_id, skill_tag) VALUES ($1, 'python'), ($1, 'data-viz')`,
      [nodeId],
    );
    const { rows: before } = await pool.query(
      `SELECT skill_tag FROM task_dag_node_skills WHERE node_id = $1`,
      [nodeId],
    );
    expect(before).toHaveLength(2);

    await pool.query(`DELETE FROM task_dag_nodes WHERE id = $1`, [nodeId]);
    const { rows: after } = await pool.query(
      `SELECT skill_tag FROM task_dag_node_skills WHERE node_id = $1`,
      [nodeId],
    );
    expect(after).toHaveLength(0);
  });

  it("a valid edge between two nodes of the SAME dag is accepted", async () => {
    const dagId = await insertDag();
    const nodeA = await insertNode(dagId);
    const nodeB = await insertNode(dagId);
    await expect(
      pool.query(
        `INSERT INTO task_dag_edges (dag_id, from_node_id, to_node_id) VALUES ($1, $2, $3)`,
        [dagId, nodeA, nodeB],
      ),
    ).resolves.toBeDefined();
  });

  it("design decision (option B): an edge cannot reference a node belonging to a DIFFERENT dag, even if both node ids are individually real", async () => {
    const dagA = await insertDag();
    const dagB = await insertDag();
    const nodeInA = await insertNode(dagA);
    const nodeInB = await insertNode(dagB);

    // Both node ids are real rows in task_dag_nodes — a plain FK against
    // task_dag_nodes(id) alone (design.md's literal draft, option A) would
    // accept this. The composite FK against (dag_id, id) must reject it
    // because dagA's edge row claims a to_node_id that only exists under
    // dagB.
    await expect(
      pool.query(
        `INSERT INTO task_dag_edges (dag_id, from_node_id, to_node_id) VALUES ($1, $2, $3)`,
        [dagA, nodeInA, nodeInB],
      ),
    ).rejects.toThrow();
  });

  it("an edge cannot be a self-loop (a node cannot be its own precondition)", async () => {
    const dagId = await insertDag();
    const nodeId = await insertNode(dagId);
    await expect(
      pool.query(
        `INSERT INTO task_dag_edges (dag_id, from_node_id, to_node_id) VALUES ($1, $2, $2)`,
        [dagId, nodeId],
      ),
    ).rejects.toThrow();
  });

  it("deleting a task_dag cascades to its nodes and edges", async () => {
    const dagId = await insertDag();
    const nodeA = await insertNode(dagId);
    const nodeB = await insertNode(dagId);
    await pool.query(
      `INSERT INTO task_dag_edges (dag_id, from_node_id, to_node_id) VALUES ($1, $2, $3)`,
      [dagId, nodeA, nodeB],
    );

    await pool.query(`DELETE FROM task_dags WHERE id = $1`, [dagId]);

    const { rows: nodeRows } = await pool.query(`SELECT id FROM task_dag_nodes WHERE dag_id = $1`, [
      dagId,
    ]);
    expect(nodeRows).toHaveLength(0);
    const { rows: edgeRows } = await pool.query(
      `SELECT dag_id FROM task_dag_edges WHERE dag_id = $1`,
      [dagId],
    );
    expect(edgeRows).toHaveLength(0);
  });

  function readRollbackSql(filename: string): string {
    const rollbackPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback",
      filename,
    );
    return readFileSync(rollbackPath, "utf8");
  }

  it(
    "N4 round-2 real finding: rolling back 0021 WITHOUT first rolling back 0022 fails loudly " +
      "instead of silently leaving 0022 recorded as applied over structures that no longer exist " +
      "(0021's rollback deliberately has no CASCADE — see its own header comment)",
    async () => {
      await insertDag();
      await expect(
        pool.query(readRollbackSql("0021_create_task_dags.rollback.sql")),
      ).rejects.toThrow(/depend/);
    },
  );

  it("rollback in the correct reverse order (0022 then 0021 — 0021's rollback also clears 0023's bookkeeping) drops everything, clearing accumulated data, and the migration set can be fully reapplied (up → down → up)", async () => {
    const dagId = await insertDag();
    await insertNode(dagId);

    await pool.query(readRollbackSql("0022_add_task_dag_node_expert_fields.rollback.sql"));
    await pool.query(readRollbackSql("0021_create_task_dags.rollback.sql"));

    const { rows: tableRows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('task_dags', 'task_dag_nodes', 'task_dag_edges', 'task_dag_node_skills')`,
    );
    expect(tableRows).toHaveLength(0);

    const { rows: migrationRows } = await pool.query<{ id: string }>(
      `SELECT id FROM schema_migrations
         WHERE id IN (
           '0021_create_task_dags.sql',
           '0022_add_task_dag_node_expert_fields.sql',
           '0023_add_task_dag_category_and_node_description.sql',
           '0024_add_task_dag_node_title_and_deadline.sql',
           '0025_make_task_dag_node_description_nullable.sql',
           '0026_add_task_dag_node_selected_predecessors.sql'
         )`,
    );
    expect(migrationRows).toHaveLength(0);

    // Reapplied via the real runner, not a manual re-run of the SQL above —
    // this is the assertion the earlier (reverted) CASCADE version of
    // 0021's rollback would have FAILED: with CASCADE, 0022's
    // schema_migrations row would still be present after 0021's rollback
    // alone, so this call would have skipped 0022 as "already applied"
    // and left task_dag_nodes without expert_type. 0023/0024/0025 are
    // included here for the same reason (N4 round-2 fix, extended to
    // 0024 in T-1702 and 0025 in T-1704): 0021's rollback now explicitly
    // clears their schema_migrations rows too, since a plain column
    // addition/alteration has no FK to force the correct order the way
    // 0022 does.
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual([
      "0021_create_task_dags.sql",
      "0022_add_task_dag_node_expert_fields.sql",
      "0023_add_task_dag_category_and_node_description.sql",
      "0024_add_task_dag_node_title_and_deadline.sql",
      "0025_make_task_dag_node_description_nullable.sql",
      "0026_add_task_dag_node_selected_predecessors.sql",
    ]);

    // Reapplied: constraints from ALL FOUR migrations work again for a
    // fresh row — expert_type (0022), category/description (0023), and
    // title/delivery_deadline (0024), not just status (0021).
    const reappliedDagId = await insertDag();
    const reappliedNodeId = await insertNode(reappliedDagId);
    const { rows: reapplied } = await pool.query<{ status: string; category: string }>(
      `SELECT status, category FROM task_dags WHERE id = $1`,
      [reappliedDagId],
    );
    expect(reapplied[0]?.status).toBe("DRAFT");
    expect(reapplied[0]?.category).toBe("writing");
    const { rows: reappliedNode } = await pool.query<{
      expert_type: string;
      description: string;
      title: string;
    }>(`SELECT expert_type, description, title FROM task_dag_nodes WHERE id = $1`, [
      reappliedNodeId,
    ]);
    expect(reappliedNode[0]?.expert_type).toBe("AUTOMATION");
    expect(reappliedNode[0]?.title).toBe("Node");
    expect(reappliedNode[0]?.description).toBe("desc");
  });

  it("task_dags.category is NOT NULL with no standing default (N4 round-2 fix, 0023)", async () => {
    await expect(
      pool.query(`INSERT INTO task_dags (requester_address, title) VALUES ($1, 'No category')`, [
        REQUESTER_ADDRESS,
      ]),
    ).rejects.toThrow();
  });
});
