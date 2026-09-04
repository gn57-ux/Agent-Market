import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

/**
 * F-1605/F-1607 (Feature 16, T-1603) — 0019_add_agent_review_status.sql's
 * own real-Postgres verification. See migrate.integration.test.ts's header
 * comment: skipped unless RUN_DB_INTEGRATION_TESTS=1 against a confirmed
 * throwaway TEST_DATABASE_URL.
 *
 * The two real requirements this migration must not violate (tasks.md
 * T-1603's own verification checklist, not just "the columns exist"):
 * 1. A historical Agent row (inserted the same way pre-migration code
 *    always did, with no `review_status`/`pricing_type` in the INSERT)
 *    must land on `review_status='ACTIVE'` — it must not vanish from the
 *    market or need re-review just because this migration ran.
 * 2. That same historical row must land on `pricing_type='PER_TASK'`, NOT
 *    `'FREE'` — the conservative default design.md 决策 5 chose
 *    specifically so no historical Agent silently gains free-tier's
 *    no-review-required status by accident of migration timing.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const OWNER_ADDRESS = "0xa183fefc63f0cd0e873a0000c6d07ef7b77e90da";

runIfOptedIn("0019_add_agent_review_status migration (integration, T-1603)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agent_review_audit_logs, agents, sessions, auth_nonces, users, consumed_privy_tokens, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE",
    );
    await pool.end();
  });

  async function insertHistoricalAgent(): Promise<string> {
    // Deliberately the SAME shape pre-Feature-16 code always used — no
    // review_status/pricing_type column mentioned at all, exactly like a
    // row that existed before this migration ever ran.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Historical Agent', 'desc', 'writing', $1) RETURNING id`,
      [OWNER_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertHistoricalAgent: no id returned");
    return id;
  }

  it("a fresh Agent row inserted after migration (no review_status/pricing_type in the INSERT) defaults to review_status='ACTIVE'", async () => {
    const agentId = await insertHistoricalAgent();
    const { rows } = await pool.query<{ review_status: string }>(
      `SELECT review_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.review_status).toBe("ACTIVE");
  });

  it("a fresh Agent row inserted after migration defaults to pricing_type='PER_TASK', NOT 'FREE' (must not silently gain free-tier no-review status)", async () => {
    const agentId = await insertHistoricalAgent();
    const { rows } = await pool.query<{ pricing_type: string }>(
      `SELECT pricing_type FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.pricing_type).toBe("PER_TASK");
  });

  it(
    "N4 round-1 P2 fix — a row that existed BEFORE this migration ran is correctly " +
      "backfilled to review_status='ACTIVE'/pricing_type='PER_TASK' (a real pre-migration " +
      "scenario: drop the two columns 0019 adds, insert a row exactly as pre-Feature-16 " +
      "code always did, then reapply the same ALTER TABLE ADD COLUMN this migration " +
      "runs — the tests above only ever proved 'what a fresh INSERT defaults to after " +
      "the columns already exist', which is a different, weaker claim)",
    async () => {
      await pool.query(`ALTER TABLE agents DROP COLUMN review_status, DROP COLUMN pricing_type`);

      const { rows: preMigrationRows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
           VALUES ($1, 'Pre-Migration Agent', 'desc', 'writing', $1) RETURNING id`,
        [OWNER_ADDRESS],
      );
      const preMigrationAgentId = preMigrationRows[0]?.id;
      if (!preMigrationAgentId) throw new Error("no id returned for pre-migration agent");

      // The exact ALTER TABLE this migration runs — this call IS the
      // backfill step, applied against a table that already has the row
      // above, not a fresh empty table.
      await pool.query(
        `ALTER TABLE agents
           ADD COLUMN review_status TEXT NOT NULL DEFAULT 'ACTIVE'
             CHECK (review_status IN ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED')),
           ADD COLUMN pricing_type TEXT NOT NULL DEFAULT 'PER_TASK'
             CHECK (pricing_type IN ('FREE', 'PER_TASK', 'SUBSCRIPTION', 'HOURLY'))`,
      );

      const { rows } = await pool.query<{ review_status: string; pricing_type: string }>(
        `SELECT review_status, pricing_type FROM agents WHERE id = $1`,
        [preMigrationAgentId],
      );
      expect(rows[0]?.review_status).toBe("ACTIVE");
      expect(rows[0]?.pricing_type).toBe("PER_TASK");
    },
  );

  it("agent_review_audit_logs.from_status/to_status reject a value outside the five-state enum (N4 round-1 P2 fix)", async () => {
    const agentId = await insertHistoricalAgent();
    await expect(
      pool.query(
        `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status)
           VALUES ($1, $2, 'ACTVE', 'ACTIVE')`,
        [agentId, OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status)
           VALUES ($1, $2, 'ACTIVE', 'NOT_A_REAL_STATE')`,
        [agentId, OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("review_status rejects a value outside the five-state enum", async () => {
    await expect(
      pool.query(
        `INSERT INTO agents (owner_address, name, description, category, payout_address, review_status)
           VALUES ($1, 'Bad Agent', 'desc', 'writing', $1, 'NOT_A_REAL_STATE')`,
        [OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("pricing_type rejects a value outside the four-state enum", async () => {
    await expect(
      pool.query(
        `INSERT INTO agents (owner_address, name, description, category, payout_address, pricing_type)
           VALUES ($1, 'Bad Agent', 'desc', 'writing', $1, 'FREEMIUM')`,
        [OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("all five review_status values are individually insertable", async () => {
    for (const state of ["DRAFT", "PENDING_REVIEW", "ACTIVE", "REJECTED", "SUSPENDED"]) {
      const { rows } = await pool.query<{ review_status: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address, review_status)
           VALUES ($1, $2, 'desc', 'writing', $1, $3) RETURNING review_status`,
        [OWNER_ADDRESS, `Agent ${state}`, state],
      );
      expect(rows[0]?.review_status).toBe(state);
    }
  });

  it("agent_review_audit_logs stores a real state-transition row and enforces a valid actor address", async () => {
    const agentId = await insertHistoricalAgent();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status, reason)
         VALUES ($1, $2, 'PENDING_REVIEW', 'ACTIVE', NULL) RETURNING id`,
      [agentId, OWNER_ADDRESS],
    );
    expect(rows[0]?.id).toBeTruthy();

    await expect(
      pool.query(
        `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status)
           VALUES ($1, 'not-a-real-address', 'PENDING_REVIEW', 'REJECTED')`,
        [agentId],
      ),
    ).rejects.toThrow();
  });

  it("agent_review_audit_logs.agent_id must reference a real Agent (foreign key enforced)", async () => {
    await expect(
      pool.query(
        `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status)
           VALUES (gen_random_uuid(), $1, 'PENDING_REVIEW', 'ACTIVE')`,
        [OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("rollback drops both new columns and agent_review_audit_logs, clearing accumulated data, and the migration can be reapplied (up → down → up)", async () => {
    const agentId = await insertHistoricalAgent();
    await pool.query(
      `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status)
         VALUES ($1, $2, 'DRAFT', 'PENDING_REVIEW')`,
      [agentId, OWNER_ADDRESS],
    );

    const rollbackPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0019_add_agent_review_status.rollback.sql",
    );
    const rollbackSql = readFileSync(rollbackPath, "utf8");
    await pool.query(rollbackSql);

    const { rows: tableRows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'agent_review_audit_logs'`,
    );
    expect(tableRows).toHaveLength(0);

    const { rows: columnRows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'agents' AND column_name IN ('review_status', 'pricing_type')`,
    );
    expect(columnRows).toHaveLength(0);

    const { rows: migrationRows } = await pool.query(
      `SELECT id FROM schema_migrations WHERE id = '0019_add_agent_review_status.sql'`,
    );
    expect(migrationRows).toHaveLength(0);

    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0019_add_agent_review_status.sql"]);

    // Reapplied: defaults and constraints work again for a fresh row.
    const reappliedAgentId = await insertHistoricalAgent();
    const { rows: reapplied } = await pool.query<{ review_status: string; pricing_type: string }>(
      `SELECT review_status, pricing_type FROM agents WHERE id = $1`,
      [reappliedAgentId],
    );
    expect(reapplied[0]?.review_status).toBe("ACTIVE");
    expect(reapplied[0]?.pricing_type).toBe("PER_TASK");
  });
});
