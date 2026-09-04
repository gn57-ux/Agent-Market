import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite is T-901's dedicated verification that
// 0009_create_deliverables.sql actually enforces, at the database layer,
// what tasks.md/design.md require: the storage_type/file_path/result_url
// mutual-exclusivity CHECK, the https-only URL CHECK, the result_hash
// shape CHECK, and (N4 round 2 P2 fix) that a task with deliverables can
// still be deleted (ON DELETE CASCADE).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const REQUESTER_ADDRESS = "0x5283fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const AGENT_ADDRESS = "0x6283fefc63f0cd0e873a0000c6d07ef7b77e90d5";
const VALID_RESULT_HASH = `0x${"a".repeat(64)}`;

runIfOptedIn("deliverables migration (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
      AGENT_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE",
    );
    await pool.end();
  });

  async function insertTask(): Promise<string> {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Test task', 'desc', 100, $2, now() + interval '7 days', 'ACCEPTED', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, "0x1111111111111111111111111111111111111111"],
    );
    if (!task) throw new Error("insertTask failed");
    return task.id;
  }

  it("accepts a LOCAL_FILE deliverable with file_path set and result_url NULL", async () => {
    const taskId = await insertTask();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, file_path, mime_type, size_bytes, result_hash)
       VALUES ($1, $2, 'LOCAL_FILE', 'some-random-uuid', 'application/pdf', 100, $3)
       RETURNING id`,
      [taskId, AGENT_ADDRESS, VALID_RESULT_HASH],
    );
    expect(rows[0]?.id).toBeTruthy();
  });

  it("accepts a URL deliverable with result_url set and file_path NULL", async () => {
    const taskId = await insertTask();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash)
       VALUES ($1, $2, 'URL', 'https://example.com/result.pdf', $3)
       RETURNING id`,
      [taskId, AGENT_ADDRESS, VALID_RESULT_HASH],
    );
    expect(rows[0]?.id).toBeTruthy();
  });

  it("rejects a LOCAL_FILE deliverable that also sets result_url (mutual exclusivity)", async () => {
    const taskId = await insertTask();
    await expect(
      pool.query(
        `INSERT INTO deliverables (task_id, agent_address, storage_type, file_path, result_url, result_hash)
         VALUES ($1, $2, 'LOCAL_FILE', 'some-uuid', 'https://example.com/x.pdf', $3)`,
        [taskId, AGENT_ADDRESS, VALID_RESULT_HASH],
      ),
    ).rejects.toThrow(/deliverables_payload_matches_storage_type/);
  });

  it("rejects a LOCAL_FILE deliverable missing file_path", async () => {
    const taskId = await insertTask();
    await expect(
      pool.query(
        `INSERT INTO deliverables (task_id, agent_address, storage_type, result_hash)
         VALUES ($1, $2, 'LOCAL_FILE', $3)`,
        [taskId, AGENT_ADDRESS, VALID_RESULT_HASH],
      ),
    ).rejects.toThrow(/deliverables_payload_matches_storage_type/);
  });

  it("rejects a non-https result_url (AC-904/F-907)", async () => {
    const taskId = await insertTask();
    await expect(
      pool.query(
        `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash)
         VALUES ($1, $2, 'URL', 'http://example.com/result.pdf', $3)`,
        [taskId, AGENT_ADDRESS, VALID_RESULT_HASH],
      ),
    ).rejects.toThrow(/deliverables_result_url_is_https/);
  });

  it("rejects a malformed result_hash", async () => {
    const taskId = await insertTask();
    await expect(
      pool.query(
        `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash)
         VALUES ($1, $2, 'URL', 'https://example.com/result.pdf', 'not-a-hash')`,
        [taskId, AGENT_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("deliverables rows are removed when their task is deleted (ON DELETE CASCADE — N4 round 2 P2 fix)", async () => {
    const taskId = await insertTask();
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash)
       VALUES ($1, $2, 'URL', 'https://example.com/result.pdf', $3)`,
      [taskId, AGENT_ADDRESS, VALID_RESULT_HASH],
    );

    // Before the fix, this DELETE would fail with a foreign key violation
    // instead of cascading — asserting it succeeds is itself part of the
    // regression coverage, not just the follow-up SELECT.
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);

    const { rows } = await pool.query(`SELECT * FROM deliverables WHERE task_id = $1`, [taskId]);
    expect(rows).toHaveLength(0);
  });

  it("tasks.submitted_at/review_deadline start NULL and accept a real timestamptz value", async () => {
    const taskId = await insertTask();
    const {
      rows: [before],
    } = await pool.query<{ submitted_at: string | null; review_deadline: string | null }>(
      `SELECT submitted_at, review_deadline FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(before?.submitted_at).toBeNull();
    expect(before?.review_deadline).toBeNull();

    await pool.query(
      `UPDATE tasks SET submitted_at = now(), review_deadline = now() + interval '72 hours' WHERE id = $1`,
      [taskId],
    );
    const {
      rows: [after],
    } = await pool.query<{ submitted_at: string | null; review_deadline: string | null }>(
      `SELECT submitted_at, review_deadline FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(after?.submitted_at).not.toBeNull();
    expect(after?.review_deadline).not.toBeNull();
  });
});
