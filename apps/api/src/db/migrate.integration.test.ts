import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";

// These tests execute real DDL (CREATE TABLE / CREATE INDEX) against
// `process.env.DATABASE_URL`. Per this session's policy, migration
// execution is treated as a high-risk operation that needs explicit human
// confirmation of the target database before running — so this suite is
// skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1 and points
// DATABASE_URL at a database they've confirmed is safe to write to (a local
// throwaway/test database, not a shared or production one).
//
// `pnpm --filter @agent-market/api test` therefore reports these as SKIPPED
// by default — that is intentional, not a gap: see the T-403 handoff report
// for what was verified without running them (SQL review, migration-runner
// logic reasoning).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

runIfOptedIn("runMigrations (integration)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS auth_nonces, users, schema_migrations CASCADE");
    await pool.end();
  });

  it("applies all migrations on first run", async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0001_create_users.sql", "0002_create_auth_nonces.sql"]);
    expect(result.alreadyApplied).toEqual([]);

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('users', 'auth_nonces')`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual(["auth_nonces", "users"]);
  });

  it("is a no-op / does not fail when run again (idempotent)", async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(["0001_create_users.sql", "0002_create_auth_nonces.sql"]);
  });
});
