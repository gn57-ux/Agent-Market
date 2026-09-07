import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CreateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runMigrations } from "../db/migrate.js";
import {
  hydrateAgentCredentialsFromManager,
  hydrateSecretsFromManager,
  OPTIONAL_SECRET_ENV_VAR_NAMES,
  REQUIRED_SECRET_ENV_VAR_NAMES,
  SECRET_ENV_VAR_NAMES,
} from "./secrets.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

/**
 * T-2301 (F-2303): real round-trip against a real LocalStack Secrets
 * Manager — no mocked/stubbed AWS SDK client anywhere in this file. Proves
 * the actual SDK integration path Q-2302's decision explicitly asked for
 * ("本轮只能实现并用本地 AWS API 模拟器验证真实 SDK 调用路径"), which real
 * AWS credentials in this environment cannot currently verify end-to-end.
 *
 * Skipped unless a human opts in with RUN_SECRETS_MANAGER_INTEGRATION_TESTS=1
 * against a running LocalStack container:
 *   docker run -d --name localstack-verify -p 4566:4566 \
 *     -e SERVICES=secretsmanager localstack/localstack:3.8
 */
const runIfOptedIn =
  process.env.RUN_SECRETS_MANAGER_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const ENDPOINT = process.env.SECRETS_MANAGER_ENDPOINT ?? "http://localhost:4566";

function testClient(): SecretsManagerClient {
  return new SecretsManagerClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

const previousEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  previousEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

runIfOptedIn("hydrateSecretsFromManager (real LocalStack, T-2301)", () => {
  beforeAll(async () => {
    const client = testClient();
    for (const name of SECRET_ENV_VAR_NAMES) {
      await client
        .send(
          new CreateSecretCommand({
            Name: `agent-market/${name}`,
            SecretString: `real-value-for-${name}`,
          }),
        )
        .catch(() => {
          // Re-running against an already-seeded LocalStack: ResourceExists is
          // expected and fine, any other error should still fail the test via
          // the assertions below actually reading the wrong value.
        });
    }
  });

  it("does nothing when SECRETS_PROVIDER is unset (default local/.env behavior unchanged)", async () => {
    setEnv("SECRETS_PROVIDER", undefined);
    setEnv("ACCEPTANCE_PERMIT_SIGNER_KEY", "already-set-from-env-file");

    await hydrateSecretsFromManager();

    expect(process.env.ACCEPTANCE_PERMIT_SIGNER_KEY).toBe("already-set-from-env-file");
  });

  it("fetches every configured secret name from a real Secrets Manager and sets it on process.env", async () => {
    setEnv("SECRETS_PROVIDER", "aws-secrets-manager");
    setEnv("SECRETS_MANAGER_ENDPOINT", ENDPOINT);
    for (const name of SECRET_ENV_VAR_NAMES) {
      setEnv(name, undefined);
    }

    await hydrateSecretsFromManager();

    for (const name of SECRET_ENV_VAR_NAMES) {
      expect(process.env[name]).toBe(`real-value-for-${name}`);
    }
  });

  it("never overwrites a name already present in process.env (real deployment env wins)", async () => {
    setEnv("SECRETS_PROVIDER", "aws-secrets-manager");
    setEnv("SECRETS_MANAGER_ENDPOINT", ENDPOINT);
    setEnv("ACCEPTANCE_PERMIT_SIGNER_KEY", "injected-directly-by-orchestrator");

    await hydrateSecretsFromManager();

    expect(process.env.ACCEPTANCE_PERMIT_SIGNER_KEY).toBe("injected-directly-by-orchestrator");
  });

  it("throws (rather than silently leaving the name unset) when a REQUIRED secret does not exist", async () => {
    setEnv("SECRETS_PROVIDER", "aws-secrets-manager");
    setEnv("SECRETS_MANAGER_ENDPOINT", ENDPOINT);
    setEnv("SECRETS_MANAGER_PREFIX", "nonexistent-namespace/");
    for (const name of SECRET_ENV_VAR_NAMES) {
      setEnv(name, undefined);
    }

    await expect(hydrateSecretsFromManager()).rejects.toThrow();
  });

  it("leaves an OPTIONAL secret unset (not a throw) when the manager genuinely has no such secret — real deployments without that feature enabled", async () => {
    setEnv("SECRETS_PROVIDER", "aws-secrets-manager");
    setEnv("SECRETS_MANAGER_ENDPOINT", ENDPOINT);
    setEnv("SECRETS_MANAGER_PREFIX", "namespace-with-only-required-secrets/");
    const client = testClient();
    for (const name of REQUIRED_SECRET_ENV_VAR_NAMES) {
      await client
        .send(
          new CreateSecretCommand({
            Name: `namespace-with-only-required-secrets/${name}`,
            SecretString: `required-value-for-${name}`,
          }),
        )
        .catch(() => {});
      setEnv(name, undefined);
    }
    for (const name of OPTIONAL_SECRET_ENV_VAR_NAMES) {
      setEnv(name, undefined);
    }

    await hydrateSecretsFromManager();

    for (const name of REQUIRED_SECRET_ENV_VAR_NAMES) {
      expect(process.env[name]).toBe(`required-value-for-${name}`);
    }
    for (const name of OPTIONAL_SECRET_ENV_VAR_NAMES) {
      expect(process.env[name]).toBeUndefined();
    }
  });
});

/**
 * T-2301 (N4 round 2 P1): real round-trip proving dynamic per-Agent
 * `env://AGENT_<id>` credentials also resolve from a real Secrets Manager
 * — against a real Postgres `agents` row (real `credential_ref`, via
 * `computeCredentialRef`'s own real format), not a fabricated shape.
 * Skipped unless BOTH `RUN_DB_INTEGRATION_TESTS=1` (real Postgres) and
 * `RUN_SECRETS_MANAGER_INTEGRATION_TESTS=1` (real LocalStack) are set.
 */
const runAgentCredentialTestIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" &&
  process.env.RUN_SECRETS_MANAGER_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

runAgentCredentialTestIfOptedIn(
  "hydrateAgentCredentialsFromManager (real Postgres + real LocalStack, T-2301)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      // N6 real finding: this suite queried `users`/`agents` without ever
      // running migrations itself, silently relying on some OTHER test
      // file in the same run having already applied them against the
      // shared test database — passed when run in isolation (this file's
      // own manual verification always ran `migrate-cli` first) but is a
      // real, order-dependent flake risk as part of the full suite,
      // exactly matching every other `*.integration.test.ts` file's own
      // convention of running its own migrations rather than assuming
      // another file already did.
      await runMigrations(pool, migrationsDir);
    });

    afterAll(async () => {
      // N6 real finding: `beforeAll` above applies migrations against the
      // SAME shared test database every other `*.integration.test.ts`
      // file uses — `apps/api`'s own `vitest.config.ts` deliberately sets
      // `fileParallelism: false` specifically because these files race
      // otherwise (that config's own comment). Leaving `schema_migrations`
      // populated here broke `db/migrate.integration.test.ts`'s "applies
      // all migrations on first run" assertion when this file happened to
      // run first in the sequential order (real full-suite run during N6,
      // not a hypothetical) — every other integration file drops its own
      // tables in `afterAll` for exactly this reason; this one must too.
      await pool.query(
        "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE",
      );
      await pool.end();
    });

    it("hydrates process.env for a real Agent's real dynamic credential_ref from Secrets Manager", async () => {
      setEnv("SECRETS_PROVIDER", "aws-secrets-manager");
      setEnv("SECRETS_MANAGER_ENDPOINT", ENDPOINT);
      setEnv("SECRETS_MANAGER_PREFIX", "agent-market/");

      const ownerAddress = `0x${"7".repeat(40)}`;
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        ownerAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'T-2301 secrets test agent', 'desc', 'writing', $1)
         RETURNING id`,
        [ownerAddress],
      );
      const agentId = rows[0]?.id;
      if (!agentId) throw new Error("insert: no id returned");
      const credentialRef = `env://AGENT_${agentId.replace(/-/g, "").toUpperCase()}`;
      await pool.query(`UPDATE agents SET credential_ref = $1 WHERE id = $2`, [
        credentialRef,
        agentId,
      ]);
      const variableName = credentialRef.replace("env://", "");
      setEnv(variableName, undefined);

      const client = testClient();
      await client
        .send(
          new CreateSecretCommand({
            Name: `agent-market/${variableName}`,
            SecretString: "real-agent-invocation-credential",
          }),
        )
        .catch(() => {});

      try {
        await hydrateAgentCredentialsFromManager(pool);
        expect(process.env[variableName]).toBe("real-agent-invocation-credential");
      } finally {
        await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
        setEnv(variableName, undefined);
      }
    });
  },
);
