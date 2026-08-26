import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// See agents-migration.integration.test.ts's header comment: skipped
// unless a human opts in with RUN_DB_INTEGRATION_TESTS=1 against a
// confirmed-safe TEST_DATABASE_URL. This suite is T-601's dedicated
// verification that 0005_create_tasks.sql actually enforces, at the
// database layer, the properties tasks.md/design.md require: the
// tasks.status CHECK mirrors the full 9-kind TaskStatus union, address
// format checks reject malformed addresses, and the chain_events unique
// key on (chain_id, block_hash, transaction_hash, log_index) — the
// idempotency guarantee F-606 depends on — actually rejects a duplicate insert.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TX_HASH = "0x" + "a".repeat(64);
const BLOCK_HASH = "0x" + "b".repeat(64);

function insertTask(pool: Pool, overrides: Partial<Record<string, unknown>> = {}) {
  const values = {
    requester_address: REQUESTER_ADDRESS,
    category: "writing",
    title: "Test Task",
    description: "desc",
    budget: "1000",
    token: TOKEN_ADDRESS,
    delivery_deadline: "2030-01-01T00:00:00Z",
    status: "DRAFT",
    idempotency_key: null as string | null,
    ...overrides,
  };
  return pool.query<{ id: string; status: string }>(
    `INSERT INTO tasks
       (requester_address, category, title, description, budget, token, delivery_deadline, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, status`,
    [
      values.requester_address,
      values.category,
      values.title,
      values.description,
      values.budget,
      values.token,
      values.delivery_deadline,
      values.status,
      values.idempotency_key,
    ],
  );
}

runIfOptedIn(
  "tasks / task_skills / chain_transactions / chain_events / task_state_history migration (integration)",
  () => {
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
        "DROP TABLE IF EXISTS pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
      );
      await pool.end();
    });

    it("inserting a task returns the expected fields with the status supplied on insert", async () => {
      const { rows } = await insertTask(pool);
      expect(rows[0]?.id).toBeTruthy();
      expect(rows[0]?.status).toBe("DRAFT");
    });

    it("rejects a status value outside the 9-kind TaskStatus union", async () => {
      await expect(insertTask(pool, { status: "NOT_A_REAL_STATUS" })).rejects.toThrow(
        /tasks_status_check/,
      );
    });

    it("rejects a requester_address that doesn't match the lowercase 0x-hex40 format", async () => {
      await expect(insertTask(pool, { requester_address: "0xNOTVALID" })).rejects.toThrow(
        /tasks_requester_address_format/,
      );
    });

    it("rejects a negative budget", async () => {
      await expect(insertTask(pool, { budget: "-1" })).rejects.toThrow(/tasks_budget_positive/);
    });

    it("rejects a zero budget (TaskEscrow.createTask reverts ZeroBudget on 0 — human review, T-605 round 3)", async () => {
      await expect(insertTask(pool, { budget: "0" })).rejects.toThrow(/tasks_budget_positive/);
    });

    it("chain_events rejects a duplicate (chain_id, block_hash, transaction_hash, log_index)", async () => {
      const {
        rows: [task],
      } = await insertTask(pool);

      const insertEvent = () =>
        pool.query(
          `INSERT INTO chain_events
           (chain_id, block_hash, transaction_hash, log_index, event_name, task_id, payload)
         VALUES (1, $1, $2, 0, 'TaskFunded', $3, '{}'::jsonb)`,
          [BLOCK_HASH, TX_HASH, task?.id],
        );

      await insertEvent();
      await expect(insertEvent()).rejects.toThrow(/chain_events_unique_log/);
    });

    it("rejects a second task from the same requester reusing an idempotency_key (F-601 regression, Codex round 1 P2)", async () => {
      await insertTask(pool, { idempotency_key: "client-key-1" });
      await expect(insertTask(pool, { idempotency_key: "client-key-1" })).rejects.toThrow(
        /tasks_requester_idempotency_key_unique/,
      );
    });

    it("allows the same idempotency_key for two different requesters", async () => {
      const OTHER_REQUESTER = "0x9f83fefc63f0cd0e873a0000c6d07ef7b77e90d9";
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        OTHER_REQUESTER,
      ]);

      await insertTask(pool, { idempotency_key: "shared-key" });
      const { rows } = await insertTask(pool, {
        requester_address: OTHER_REQUESTER,
        idempotency_key: "shared-key",
      });
      expect(rows[0]?.id).toBeTruthy();
    });

    it("allows multiple tasks with no idempotency_key from the same requester (NULL is not a duplicate)", async () => {
      await insertTask(pool);
      const { rows } = await insertTask(pool);
      expect(rows[0]?.id).toBeTruthy();
    });

    it("task_skills rows are removed when their task is deleted (ON DELETE CASCADE)", async () => {
      const {
        rows: [task],
      } = await insertTask(pool);
      await pool.query(`INSERT INTO task_skills (task_id, skill_tag) VALUES ($1, 'copywriting')`, [
        task?.id,
      ]);

      await pool.query(`DELETE FROM tasks WHERE id = $1`, [task?.id]);

      const { rows } = await pool.query(`SELECT * FROM task_skills WHERE task_id = $1`, [task?.id]);
      expect(rows).toHaveLength(0);
    });
  },
);
