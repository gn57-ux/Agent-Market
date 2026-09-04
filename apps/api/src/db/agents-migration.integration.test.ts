import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite is T-501's dedicated verification that the
// 0004_create_agents.sql migration actually enforces, at the database
// layer, the two properties tasks.md requires: a newly inserted agent row
// has quality_score = NULL (never a written neutral-prior value — see
// design.md's data model section), and the CHECK constraints reject
// malformed addresses / out-of-range scores.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const OWNER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";

runIfOptedIn("agents / agent_skills migration (integration)", () => {
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
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("inserting a new agent row leaves quality_score NULL by default", async () => {
    const { rows } = await pool.query<{
      quality_score: number | null;
      status: string;
      completed_task_count: number;
    }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Test Agent', 'desc', 'writing', $1)
       RETURNING quality_score, status, completed_task_count`,
      [OWNER_ADDRESS],
    );
    expect(rows[0]?.quality_score).toBeNull();
    expect(rows[0]?.status).toBe("ACTIVE");
    expect(rows[0]?.completed_task_count).toBe(0);
  });

  it("rejects an owner_address that doesn't match the lowercase 0x-hex40 format", async () => {
    await expect(
      pool.query(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Bad Owner', 'desc', 'writing', $1)`,
        ["0xNOTVALID"],
      ),
    ).rejects.toThrow(/agents_owner_address_format/);
  });

  it("rejects a payout_address that doesn't match the lowercase 0x-hex40 format", async () => {
    await expect(
      pool.query(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Bad Payout', 'desc', 'writing', 'not-an-address')`,
        [OWNER_ADDRESS],
      ),
    ).rejects.toThrow(/agents_payout_address_format/);
  });

  it("rejects a quality_score outside [0, 1]", async () => {
    await expect(
      pool.query(
        `INSERT INTO agents (owner_address, name, description, category, payout_address, quality_score)
         VALUES ($1, 'Bad Score', 'desc', 'writing', $1, 1.5)`,
        [OWNER_ADDRESS],
      ),
    ).rejects.toThrow(/agents_quality_score_range/);
  });

  it("agent_skills rows are removed when their agent is deleted (ON DELETE CASCADE)", async () => {
    const {
      rows: [agent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Cascade Agent', 'desc', 'writing', $1)
       RETURNING id`,
      [OWNER_ADDRESS],
    );
    await pool.query(`INSERT INTO agent_skills (agent_id, skill_tag) VALUES ($1, 'copywriting')`, [
      agent?.id,
    ]);

    await pool.query(`DELETE FROM agents WHERE id = $1`, [agent?.id]);

    const { rows } = await pool.query(`SELECT * FROM agent_skills WHERE agent_id = $1`, [
      agent?.id,
    ]);
    expect(rows).toHaveLength(0);
  });
});
