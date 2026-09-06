import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "./signInMessage.js";
import { createSiweIdentityProvider } from "./siwe-identity-provider.js";

/**
 * F-1601/F-1602 (Feature 16, T-1600) — real-Postgres contract tests for
 * `SiweIdentityProvider`, the default `IdentityProvider` implementation.
 * `routes.integration.test.ts`/`completeLogin.integration.test.ts` already
 * cover the end-to-end HTTP flow through this provider (AC-1601's
 * non-regression requirement); this file targets the provider's own
 * interface contract directly — including a real runtime check that a
 * successful `completeAuth` result carries ONLY `address` (F-1602: no SDK
 * object, no internal state, ever leaks through this boundary), not just a
 * TypeScript-compile-time argument.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn("SiweIdentityProvider (integration, T-1600)", () => {
  let pool: Pool;
  const provider = createSiweIdentityProvider();
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM auth_nonces");
  });

  it("beginAuth issues a real challenge tied to the given address", async () => {
    const challenge = await provider.beginAuth(pool, account.address);
    expect(challenge.address.toLowerCase()).toBe(account.address.toLowerCase());
    expect(challenge.nonce).toHaveLength(64); // 32 bytes hex-encoded
    expect(challenge.expiresAt.getTime()).toBeGreaterThan(challenge.issuedAt.getTime());
  });

  it(
    "completeAuth succeeds on a real valid signature and returns EXACTLY {address} — " +
      "no other property (F-1602's real runtime boundary, not just a TS type)",
    async () => {
      const challenge = await provider.beginAuth(pool, account.address);
      const message = buildSignInMessage({
        domain: "localhost",
        address: account.address,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      });
      const signature = await account.signMessage({ message });

      const outcome = await provider.completeAuth(pool, {
        address: account.address,
        nonce: challenge.nonce,
        proof: { signature },
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      expect(outcome.result.address).toBe(account.address.toLowerCase());
      // The real, runtime-enforced half of F-1602: whatever this object
      // is, it has ONE key. A future implementation bug that spread a
      // Privy SDK object (or any extra field) into the result would fail
      // this assertion even if it still happened to typecheck.
      expect(Object.keys(outcome.result)).toEqual(["address"]);
    },
  );

  it("completeAuth rejects a malformed proof shape (not even a signature-like string)", async () => {
    const challenge = await provider.beginAuth(pool, account.address);
    const outcome = await provider.completeAuth(pool, {
      address: account.address,
      nonce: challenge.nonce,
      proof: { signature: "not-hex-at-all" },
    });
    expect(outcome).toEqual({ ok: false, reason: "invalid_proof" });
  });

  it("completeAuth rejects a real signature from the WRONG account for this nonce", async () => {
    const wrongAccount = privateKeyToAccount(generatePrivateKey());
    const challenge = await provider.beginAuth(pool, account.address);
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    const signature = await wrongAccount.signMessage({ message });

    const outcome = await provider.completeAuth(pool, {
      address: account.address,
      nonce: challenge.nonce,
      proof: { signature },
    });
    expect(outcome).toEqual({ ok: false, reason: "invalid_proof" });
  });

  it("completeAuth reports not_found for a nonce that was never issued", async () => {
    const outcome = await provider.completeAuth(pool, {
      address: account.address,
      nonce: "0".repeat(64),
      proof: { signature: "0x00" },
    });
    expect(outcome).toEqual({ ok: false, reason: "not_found" });
  });

  it(
    "rejects a real sequential replay of an already-used nonce — as not_found, not " +
      "already_consumed: getActiveNonce's own WHERE clause already excludes consumed " +
      "rows, so a plain (non-concurrent) replay never reaches consumeNonce's more " +
      "specific reason at all here. already_consumed IS real and reachable, just one " +
      "layer down — nonce.store.integration.test.ts calls consumeNonce directly " +
      "(bypassing this provider's own getActiveNonce pre-check) and asserts it for " +
      "real; that coverage is not duplicated here.",
    async () => {
      const challenge = await provider.beginAuth(pool, account.address);
      const message = buildSignInMessage({
        domain: "localhost",
        address: account.address,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      });
      const signature = await account.signMessage({ message });
      const proof = { signature };

      const first = await provider.completeAuth(pool, {
        address: account.address,
        nonce: challenge.nonce,
        proof,
      });
      expect(first.ok).toBe(true);

      const replay = await provider.completeAuth(pool, {
        address: account.address,
        nonce: challenge.nonce,
        proof,
      });
      expect(replay).toEqual({ ok: false, reason: "not_found" });
    },
  );
});
