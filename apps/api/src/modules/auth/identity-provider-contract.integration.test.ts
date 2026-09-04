import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import type { IdentityProvider } from "./identity-provider.js";
import { createPrivyIdentityProvider } from "./privy-identity-provider.js";
import { createSiweIdentityProvider } from "./siwe-identity-provider.js";

/**
 * F-1601/F-1602 (T-1601) — a single, shared contract test both
 * `IdentityProvider` implementations must satisfy, so this project has one
 * place enforcing the interface's universal invariants (CLAUDE.md 原则 6)
 * instead of re-deriving the same assertions independently per provider
 * file, which risks the two subtly drifting apart. Provider-specific
 * behavior (SIWE's nonce lifecycle; Privy's real-token verification, see
 * `privy-identity-provider.integration.test.ts`'s header comment for what
 * could and couldn't be exercised there) stays in each provider's own
 * dedicated integration test file — this file only covers assertions that
 * are true of `IdentityProvider` AS AN INTERFACE, regardless of which
 * implementation backs it.
 *
 * `providers` below is built eagerly, at module scope — NOT inside
 * `beforeAll`. Both factories are synchronous, pure construction (no I/O:
 * `new PrivyClient(...)` doesn't itself make a network call, verified when
 * writing `privy-identity-provider.test.ts`), so there's no async work to
 * defer. This matters concretely for `describe.each` below: Vitest calls
 * describe-body callbacks to COLLECT the test tree before any `beforeAll`
 * hook runs, so a `providers` array populated inside `beforeAll` would
 * still be empty when `describe.each` reads it — silently registering zero
 * per-provider tests while the suite still reports green. (Caught by
 * actually running this file with `--reporter=verbose` and noticing only
 * the sanity test below appeared — an earlier version of this file had
 * exactly that bug.)
 */
const providers: Array<{ name: string; provider: IdentityProvider }> = [
  { name: "SIWE", provider: createSiweIdentityProvider() },
];
const privyProvider = createPrivyIdentityProvider();
if (privyProvider) {
  providers.push({ name: "Privy", provider: privyProvider });
}
// No fallback/skip-with-fake-pass when Privy credentials are absent: this
// suite then simply contract-tests only SIWE — the same honest "don't
// pretend to cover what wasn't run" principle as the dedicated Privy
// suite's `it.skip` blocks, not a silent gap.

const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn("IdentityProvider contract (shared, T-1601)", () => {
  let pool: Pool;
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM auth_nonces");
  });

  it("registered at least SIWE (sanity: this suite is not vacuously passing over zero providers)", () => {
    expect(providers.length).toBeGreaterThanOrEqual(1);
  });

  describe.each(providers.map((p): [string, IdentityProvider] => [p.name, p.provider]))(
    "%s",
    (_name, provider) => {
      it("beginAuth returns a well-formed AuthChallenge for a given address", async () => {
        const challenge = await provider.beginAuth(pool, account.address);
        expect(challenge.address).toBe(account.address.toLowerCase());
        expect(typeof challenge.nonce).toBe("string");
        expect(challenge.nonce.length).toBeGreaterThan(0);
        expect(challenge.expiresAt.getTime()).toBeGreaterThan(challenge.issuedAt.getTime());
      });

      it("completeAuth rejects a proof that isn't even the right shape, with reason invalid_proof", async () => {
        const outcome = await provider.completeAuth(pool, {
          address: account.address,
          nonce: "0".repeat(64),
          proof: { thisFieldNameMatchesNoProvider: true },
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("unreachable");
        expect(outcome.reason).toBe("invalid_proof");
      });

      it("completeAuth's failure reason is always one of CompleteAuthResult's declared reasons", async () => {
        const outcome = await provider.completeAuth(pool, {
          address: account.address,
          nonce: "not-a-real-nonce",
          proof: null,
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("unreachable");
        expect(["not_found", "already_consumed", "expired", "invalid_proof"]).toContain(
          outcome.reason,
        );
      });
    },
  );
});
