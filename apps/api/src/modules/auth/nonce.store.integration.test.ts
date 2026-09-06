import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { consumeNonce, issueNonce } from "./nonce.store.js";
import { findUserByAddress, recordLogin } from "./users.store.js";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite proves F-405 ("nonce 一次性使用") and the
// migration-runner's schema once opted into.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const ADDRESS = "0x4283FeFc63F0Cd0e873a0000C6D07eF7B77e90D3";

runIfOptedIn("nonce.store (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, schema_migrations CASCADE",
    );
    await pool.end();
  });

  it("issues a nonce and consumes it exactly once", async () => {
    const issued = await issueNonce(pool, ADDRESS);
    expect(issued.address).toBe(ADDRESS.toLowerCase());
    expect(issued.expiresAt.getTime()).toBeGreaterThan(issued.issuedAt.getTime());

    const firstConsume = await consumeNonce(pool, ADDRESS, issued.nonce);
    expect(firstConsume).toEqual({ ok: true });

    const secondConsume = await consumeNonce(pool, ADDRESS, issued.nonce);
    expect(secondConsume).toEqual({ ok: false, reason: "already_consumed" });
  });

  it("rejects a nonce that was never issued", async () => {
    const result = await consumeNonce(pool, ADDRESS, "not-a-real-nonce");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an expired nonce", async () => {
    const issued = await issueNonce(pool, ADDRESS);
    // Force expiry directly (bypassing the 10-minute TTL) to test the
    // expired branch deterministically instead of sleeping in a test.
    await pool.query(
      `UPDATE auth_nonces SET expires_at = now() - interval '1 second' WHERE nonce = $1`,
      [issued.nonce],
    );

    const result = await consumeNonce(pool, ADDRESS, issued.nonce);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("issuing a new nonce supersedes the previous unconsumed one", async () => {
    const first = await issueNonce(pool, ADDRESS);
    const second = await issueNonce(pool, ADDRESS);
    expect(second.nonce).not.toBe(first.nonce);

    const consumeOld = await consumeNonce(pool, ADDRESS, first.nonce);
    expect(consumeOld).toEqual({ ok: false, reason: "already_consumed" });

    const consumeNew = await consumeNonce(pool, ADDRESS, second.nonce);
    expect(consumeNew).toEqual({ ok: true });
  });

  it("serializes concurrent issueNonce calls for the same address so at most one stays unconsumed", async () => {
    // Regression for Codex review round 1 P2: without per-address
    // serialization, two concurrent issuances could each supersede-then-
    // insert before the other commits, leaving two consumed=false rows.
    const [first, second] = await Promise.all([
      issueNonce(pool, ADDRESS),
      issueNonce(pool, ADDRESS),
    ]);
    expect(first.nonce).not.toBe(second.nonce);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_nonces WHERE address = $1 AND consumed = false`,
      [ADDRESS.toLowerCase()],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("recordLogin creates then updates a user row for the normalized address", async () => {
    const created = await recordLogin(pool, ADDRESS);
    expect(created.address).toBe(ADDRESS.toLowerCase());
    expect(created.lastLoginAt).not.toBeNull();

    // Differently-cased lookup for the same address: keep the mandatory
    // lowercase "0x" prefix (normalizeAddress's regex requires it) but
    // uppercase the hex payload, to prove case-insensitive lookup works.
    const differentlyCased = "0x" + ADDRESS.slice(2).toUpperCase();
    const found = await findUserByAddress(pool, differentlyCased);
    expect(found?.address).toBe(ADDRESS.toLowerCase());
  });
});
