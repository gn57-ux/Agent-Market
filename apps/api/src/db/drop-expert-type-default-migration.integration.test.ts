import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1201b's own verification that
// 0014_drop_expert_type_default.sql actually removes the compatibility
// DEFAULT 0013 (T-1200) deliberately kept — see that migration's own doc
// comment for why. The "before" half of this regression (an omitted
// expert_type still defaulting to AUTOMATION) is already covered by
// agent-task-credentials-migration.integration.test.ts's own dedicated
// test — this file only needs to prove the "after" half: that this
// migration genuinely closes the gap.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const REQUESTER_ADDRESS = "0x8283fefc63f0cd0e873a0000c6d07ef7b77e90d7";
const TOKEN_ADDRESS = "0x9283fefc63f0cd0e873a0000c6d07ef7b77e90d8";

runIfOptedIn("tasks.expert_type DROP DEFAULT migration (integration, T-1201b)", () => {
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
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE",
    );
    await pool.end();
  });

  async function insertTaskOmittingExpertType() {
    return pool.query(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2033-01-01T00:00:00Z', 'DRAFT')
       RETURNING expert_type`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
  }

  // T-1200 round 1's original P1 concern (a standing DEFAULT silently
  // masking a future bug where a write path forgets to supply the field)
  // is what this migration actually closes — proven here by the omission
  // now failing outright instead of silently landing on 'AUTOMATION'.
  it("rejects an insert that omits expert_type once the DEFAULT is dropped", async () => {
    await expect(insertTaskOmittingExpertType()).rejects.toThrow();
  });

  it("still accepts an insert that explicitly supplies expert_type", async () => {
    const { rows } = await pool.query<{ expert_type: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2033-01-01T00:00:00Z', 'DRAFT', 'RESEARCH')
       RETURNING expert_type`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    expect(rows[0]?.expert_type).toBe("RESEARCH");
  });

  it("rollback restores the DEFAULT (omission succeeds again as AUTOMATION), and the migration can be reapplied", async () => {
    const rollbackPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0014_drop_expert_type_default.rollback.sql",
    );
    const rollbackSql = await import("node:fs").then((fs) => fs.readFileSync(rollbackPath, "utf8"));
    await pool.query(rollbackSql);

    const { rows } = await insertTaskOmittingExpertType();
    expect(rows[0]?.expert_type).toBe("AUTOMATION");

    const { rows: migrationRows } = await pool.query(
      `SELECT id FROM schema_migrations WHERE id = '0014_drop_expert_type_default.sql'`,
    );
    expect(migrationRows).toHaveLength(0);

    // Reapply (up/down/up): the migration must be idempotently re-runnable
    // after a rollback, not leave the database in a state runMigrations
    // can't recover from.
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0014_drop_expert_type_default.sql"]);

    await expect(insertTaskOmittingExpertType()).rejects.toThrow();
  });
});
