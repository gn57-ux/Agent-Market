import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// These tests execute real DDL (CREATE TABLE / CREATE INDEX) against a real
// PostgreSQL database. Per this session's policy, migration execution is
// treated as a high-risk operation that needs explicit human confirmation
// of the target database before running — so this suite is skipped unless
// a human opts in with RUN_DB_INTEGRATION_TESTS=1 and TEST_DATABASE_URL
// pointing at a database they've confirmed is safe to write to (a dedicated
// local throwaway/test database — see test-support.ts's
// requireTestDatabaseUrl for why this must be a separate variable from the
// app's normal DATABASE_URL, and why the database name itself is checked).
//
// `pnpm --filter @agent-market/api test` therefore reports these as SKIPPED
// by default on a machine that hasn't set TEST_DATABASE_URL — that's
// intentional (no destructive DDL runs without explicit opt-in), not
// evidence these are unverified: see the T-403 handoff report for the run
// used to actually verify this suite end to end.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

runIfOptedIn("runMigrations (integration)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS recommendation_candidates, recommendation_runs, task_state_history, chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("applies all migrations on first run", async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual([
      "0001_create_users.sql",
      "0002_create_auth_nonces.sql",
      "0003_create_sessions.sql",
      "0004_create_agents.sql",
      "0005_create_tasks.sql",
      "0006_add_dispatch_matching_fields.sql",
      "0007_create_recommendation_tables.sql",
    ]);
    expect(result.alreadyApplied).toEqual([]);

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN ('users', 'auth_nonces', 'sessions', 'agents', 'agent_skills',
         'tasks', 'task_skills', 'chain_transactions', 'chain_events', 'task_state_history',
         'blocked_wallets', 'recommendation_runs', 'recommendation_candidates')`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([
      "agent_skills",
      "agents",
      "auth_nonces",
      "blocked_wallets",
      "chain_events",
      "chain_transactions",
      "recommendation_candidates",
      "recommendation_runs",
      "sessions",
      "task_skills",
      "task_state_history",
      "tasks",
      "users",
    ]);
  });

  it("is a no-op / does not fail when run again (idempotent)", async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual([
      "0001_create_users.sql",
      "0002_create_auth_nonces.sql",
      "0003_create_sessions.sql",
      "0004_create_agents.sql",
      "0005_create_tasks.sql",
      "0006_add_dispatch_matching_fields.sql",
      "0007_create_recommendation_tables.sql",
    ]);
  });
});
