import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { completeLogin } from "./completeLogin.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { issueNonce } from "./nonce.store.js";
import { buildSignInMessage } from "./signInMessage.js";
import { createSiweIdentityProvider } from "./siwe-identity-provider.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const account = privateKeyToAccount(generatePrivateKey());
const provider = createSiweIdentityProvider();

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
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE",
    );
    await pool.end();
  });

  /** F-1601 (T-1600): completeLogin now verifies the proof itself (via
   * `provider.completeAuth`) rather than trusting a pre-verified nonce —
   * this signs a real message so `completeAuth`'s real signature check
   * inside the transaction actually passes, exercising the real
   * production code path rather than a stub that would trivially "roll
   * back" without ever touching the real nonce-consumption write this
   * test's whole point is to verify. */
  async function realProof(nonce: string, issuedAt: Date, expiresAt: Date): Promise<unknown> {
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce,
      issuedAt,
      expiresAt,
    });
    const signature = await account.signMessage({ message });
    return { signature };
  }

  it("rolls back nonce consumption when session issuance fails mid-transaction", async () => {
    const issued = await issueNonce(pool, account.address);
    const proof = await realProof(issued.nonce, issued.issuedAt, issued.expiresAt);

    // Force the session-issuance INSERT to fail structurally, so
    // completeLogin's transaction has something genuine to roll back —
    // not a network/timing flake, a deterministic schema-level failure.
    await pool.query("DROP TABLE sessions CASCADE");

    await expect(
      completeLogin(pool, provider, account.address, issued.nonce, proof),
    ).rejects.toThrow();

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
    // too. A retry with the same real proof (same nonce, same signature —
    // still valid since the nonce was never really consumed) must succeed.
    const retry = await completeLogin(pool, provider, account.address, issued.nonce, proof);
    expect(retry.ok).toBe(true);
  });
});
