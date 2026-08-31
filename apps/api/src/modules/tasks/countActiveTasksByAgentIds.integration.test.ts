import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { countActiveTasksByAgentIds } from "./repository.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-705's dedicated verification of
// `countActiveTasksByAgentIds` — the real implementation of the query
// dispatch-matching-migration.integration.test.ts (T-700) already asserted
// by hand against `tasks` directly. This suite proves the function itself
// (Map shape, multi-agent grouping, the empty-input short-circuit).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, " +
  "sessions, auth_nonces, users, schema_migrations CASCADE";

const OWNER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const REQUESTER_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TOKEN_ADDRESS = "0x6683fefc63f0cd0e873a0000c6d07ef7b77e90d5";

async function insertAgent(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agents (owner_address, name, description, category, payout_address)
     VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
    [OWNER_ADDRESS],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("insertAgent: no id returned");
  return id;
}

async function insertTask(
  pool: Pool,
  status: string,
  acceptedAgentId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO tasks
       (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id, expert_type)
     VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', $3, $4, 'AUTOMATION')`,
    [REQUESTER_ADDRESS, TOKEN_ADDRESS, status, acceptedAgentId],
  );
}

runIfOptedIn("countActiveTasksByAgentIds (integration, T-705)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
    ]);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  it("returns an empty Map without querying when agentIds is empty", async () => {
    const result = await countActiveTasksByAgentIds(pool, []);
    expect(result).toEqual(new Map());
  });

  it("counts only ACCEPTED/SUBMITTED/DISPUTED tasks, grouped correctly across multiple agents", async () => {
    const agentA = await insertAgent(pool);
    const agentB = await insertAgent(pool);
    const agentC = await insertAgent(pool); // no tasks at all

    await insertTask(pool, "ACCEPTED", agentA);
    await insertTask(pool, "SUBMITTED", agentA);
    await insertTask(pool, "OPEN", agentA); // not occupying
    await insertTask(pool, "DISPUTED", agentB);
    await insertTask(pool, "RELEASED", agentB); // not occupying

    const result = await countActiveTasksByAgentIds(pool, [agentA, agentB, agentC]);

    expect(result.get(agentA)).toBe(2);
    expect(result.get(agentB)).toBe(1);
    expect(result.has(agentC)).toBe(false);
  });

  it("only counts agents actually included in the requested agentIds", async () => {
    const agentA = await insertAgent(pool);
    const agentB = await insertAgent(pool);
    await insertTask(pool, "ACCEPTED", agentA);
    await insertTask(pool, "ACCEPTED", agentB);

    const result = await countActiveTasksByAgentIds(pool, [agentA]);

    expect(result.get(agentA)).toBe(1);
    expect(result.has(agentB)).toBe(false);
  });
});
