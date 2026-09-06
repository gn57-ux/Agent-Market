import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { isAdminAddress } from "../src/modules/admin/repository.js";
import { getPool } from "../src/db/pool.js";
import { bootstrapAdmin } from "./admin-bootstrap.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. Proves T-1607's bootstrap-gap fix: on a genuinely
// empty `admin_roles` table (no HTTP path can ever grant the first admin —
// every caller of POST /admin/roles is 403 with none pre-existing), this
// script can still seed one directly.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

runIfOptedIn("admin-bootstrap bootstrapAdmin (integration, T-1607)", () => {
  let pool: Pool;

  beforeAll(async () => {
    // `bootstrapAdmin` calls the module-level `getPool()` internally (same
    // as `runBackfill`'s own Provider — this script is meant to run
    // standalone against DATABASE_URL), so the test points that same
    // singleton at the throwaway test database via TEST_DATABASE_URL,
    // exactly like `backfill-embeddings.integration.test.ts` does not need
    // to (it takes a Pool directly) — bootstrapAdmin's signature is
    // deliberately just `(address: string)`, matching how an operator
    // actually invokes it from the CLI with no pool to pass in.
    process.env.DATABASE_URL = requireTestDatabaseUrl();
    pool = getPool();
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM admin_role_audit_logs");
    await pool.query("DELETE FROM admin_roles");
  });

  it("seeds the first admin on a genuinely empty table", async () => {
    const address = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
    expect(await isAdminAddress(pool, address)).toBe(false);

    await bootstrapAdmin(address);

    expect(await isAdminAddress(pool, address)).toBe(true);
    const { rows } = await pool.query(
      `SELECT address, granted_by FROM admin_roles WHERE address = $1`,
      [address],
    );
    // Self-granted (no other admin exists to attribute the bootstrap to —
    // this script's own header comment).
    expect(rows).toEqual([{ address, granted_by: address }]);
  });

  it("running it again for an already-bootstrapped address is a safe no-op (idempotent, per admin-bootstrap.ts's reuse of grantAdminRole)", async () => {
    const address = "0xb283fefc63f0cd0e873a0000c6d07ef7b77e91db";
    await bootstrapAdmin(address);
    await bootstrapAdmin(address);

    const { rows } = await pool.query(`SELECT * FROM admin_roles WHERE address = $1`, [address]);
    expect(rows).toHaveLength(1);
  });

  it("accepts an uppercase/mixed-case address and normalizes it, matching how every other login/grant path in this codebase normalizes addresses", async () => {
    const mixedCase = "0xC283fefc63f0cd0e873A0000C6d07ef7b77e91dC";
    await bootstrapAdmin(mixedCase);

    expect(await isAdminAddress(pool, mixedCase.toLowerCase())).toBe(true);
  });
});
