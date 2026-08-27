import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { completeLogin } from "./completeLogin.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { issueNonce } from "./nonce.store.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const ADDRESS = "0x4283FeFc63F0Cd0e873a0000C6D07eF7B77e90D3";

runIfOptedIn("completeLogin (integration, Codex round-2 P2 regression)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    // Restore the schema unconditionally, in case the mid-test DROP below
    // wasn't reached due to an earlier failure — afterAll must never leave
    // the shared test database missing a table for the next suite.
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("rolls back nonce consumption when session issuance fails mid-transaction", async () => {
    const issued = await issueNonce(pool, ADDRESS);

    // Force the session-issuance INSERT to fail structurally, so
    // completeLogin's transaction has something genuine to roll back —
    // not a network/timing flake, a deterministic schema-level failure.
    await pool.query("DROP TABLE sessions CASCADE");

    await expect(completeLogin(pool, ADDRESS, issued.nonce)).rejects.toThrow();

    // Restore the table so the nonce-still-valid assertion below can
    // actually issue a session again. Must also clear 0003's bookkeeping
    // row — runMigrations would otherwise see "0003_create_sessions.sql
    // already applied" (schema_migrations was untouched by the DROP TABLE
    // above, only the table itself was) and skip re-running it, leaving
    // `sessions` missing.
    await pool.query("DELETE FROM schema_migrations WHERE id = '0003_create_sessions.sql'");
    await runMigrations(pool, migrationsDir);

    // The critical assertion: the nonce must NOT have been permanently
    // burned by the failed attempt — consumeNonce's UPDATE ran inside the
    // same transaction as the failed INSERT, so it must have rolled back
    // too. A retry with the same nonce must succeed.
    const retry = await completeLogin(pool, ADDRESS, issued.nonce);
    expect(retry.ok).toBe(true);
  });
});
