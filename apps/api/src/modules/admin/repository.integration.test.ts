import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { grantAdminRole, isAdminAddress, revokeAdminRole } from "./repository.js";

const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn("admin/repository (integration, T-1607)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agent_review_audit_logs, agents, sessions, auth_nonces, users, consumed_privy_tokens, admin_role_audit_logs, admin_roles, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM admin_role_audit_logs");
    await pool.query("DELETE FROM admin_roles");
  });

  it("isAdminAddress: false for an address never granted, true once granted", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const address = account.address.toLowerCase();

    expect(await isAdminAddress(pool, address)).toBe(false);
    await grantAdminRole(pool, address, address);
    expect(await isAdminAddress(pool, address)).toBe(true);
  });

  it("grantAdminRole: two concurrent grants for the SAME address never both succeed (INSERT ... ON CONFLICT DO NOTHING closes the race window)", async () => {
    const actor = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const target = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

    const [first, second] = await Promise.all([
      grantAdminRole(pool, target, actor),
      grantAdminRole(pool, target, actor),
    ]);
    const results = [first, second];
    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({ ok: false, reason: "already_admin" });

    const { rows } = await pool.query(`SELECT * FROM admin_roles WHERE address = $1`, [target]);
    expect(rows).toHaveLength(1);
    const { rows: auditRows } = await pool.query(
      `SELECT * FROM admin_role_audit_logs WHERE target_address = $1`,
      [target],
    );
    expect(auditRows).toHaveLength(1);
  });

  it("revokeAdminRole: revoking an address that was never granted returns not_admin, writes nothing", async () => {
    const actor = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const target = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

    const result = await revokeAdminRole(pool, target, actor);
    expect(result).toEqual({ ok: false, reason: "not_admin" });

    const { rows } = await pool.query(
      `SELECT * FROM admin_role_audit_logs WHERE target_address = $1`,
      [target],
    );
    expect(rows).toEqual([]);
  });

  it("revokeAdminRole: revoking twice concurrently only ever removes the row once", async () => {
    const actor = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const target = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    // A second admin must exist, or every revoke of `target` (the only
    // admin) would hit the last_admin guard instead of the double-revoke
    // race this test is actually about.
    await grantAdminRole(pool, actor, actor);
    await grantAdminRole(pool, target, actor);

    const [first, second] = await Promise.all([
      revokeAdminRole(pool, target, actor),
      revokeAdminRole(pool, target, actor),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);

    expect(await isAdminAddress(pool, target)).toBe(false);
  });

  it("revokeAdminRole: refuses to revoke the only remaining admin (last_admin), and the row is left untouched", async () => {
    const onlyAdmin = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    await grantAdminRole(pool, onlyAdmin, onlyAdmin);

    const result = await revokeAdminRole(pool, onlyAdmin, onlyAdmin);
    expect(result).toEqual({ ok: false, reason: "last_admin" });
    expect(await isAdminAddress(pool, onlyAdmin)).toBe(true);

    const { rows } = await pool.query(
      `SELECT * FROM admin_role_audit_logs WHERE target_address = $1 AND action = 'REVOKE'`,
      [onlyAdmin],
    );
    expect(rows).toEqual([]);
  });

  it("revokeAdminRole: with exactly two admins, concurrently revoking BOTH never leaves zero admins (the last_admin guard closes the race, not just the single-request check)", async () => {
    const admin1 = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const admin2 = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    await grantAdminRole(pool, admin1, admin1);
    await grantAdminRole(pool, admin2, admin1);

    const [first, second] = await Promise.all([
      revokeAdminRole(pool, admin1, admin2),
      revokeAdminRole(pool, admin2, admin1),
    ]);
    const results = [first, second];
    // Exactly one of the two concurrent revokes must be rejected as
    // last_admin (whichever runs second, once it re-observes the other's
    // committed delete) — the whole point of locking every row up front.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "last_admin")).toHaveLength(
      1,
    );

    const { rows } = await pool.query(`SELECT address FROM admin_roles`);
    expect(rows).toHaveLength(1);
  });
});
