import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "./signInMessage.js";
import type { AuthChallenge, CompleteAuthResult, IdentityProvider } from "./identity-provider.js";

/**
 * F-1603 / AC-1603 (Feature 16, T-1602) — identity migration/rollback.
 *
 * A real architectural fact, not a testing shortcut: a Privy embedded
 * wallet is a Privy-generated NEW keypair (ADR-0002) — it cannot reuse an
 * address a user already controls via an external wallet's private key
 * (SIWE/MetaMask). "同一地址切换 provider 后历史数据仍正确关联" therefore
 * cannot mean "the same physical private key authenticates through two
 * different providers" — that is not how embedded wallets work, and no
 * real Privy account could ever produce that scenario.
 *
 * What AC-1603 actually asserts, and what design.md 决策 1 was built to
 * guarantee, is narrower and fully real: this project's OWN session/
 * business-logic layer (`completeLogin`, `sessions`, `agents`, `tasks`)
 * is providers-agnostic — it only ever depends on `IdentityProvider.
 * completeAuth` returning a verified address string, never on which
 * concrete implementation produced it. That claim is directly,
 * mechanically testable by authenticating the SAME address through TWO
 * DIFFERENT `IdentityProvider` implementations registered on the SAME
 * app instance, via the exact composition-root seam (`privyIdentityProvider`,
 * app.ts) production code uses for the real Privy implementation and for
 * F-1603's rollback. The second implementation here is a minimal
 * deterministic stub — not because Privy's own verification is untested
 * (that is `privy-identity-provider.integration.test.ts`'s real-API job,
 * see its header comment on why a live account can't be used for this
 * particular scenario either), but because THIS suite's subject is our
 * own downstream code, which does not care how `completeAuth` produced
 * its `{address}` result.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

/**
 * A second, structurally distinct `IdentityProvider` — always resolves
 * `completeAuth` to the one fixed address it was constructed for,
 * regardless of `input.proof`'s content. Registered via the same
 * `privyIdentityProvider` seam the real `PrivyIdentityProvider` uses
 * (app.ts), so `POST /auth/verify/privy` in this suite runs through the
 * exact same route/`completeLogin`/session code path production traffic
 * would, only the token-verification step itself is swapped out.
 */
function fixedAddressStubProvider(address: string): IdentityProvider {
  return {
    async beginAuth(): Promise<AuthChallenge> {
      const issuedAt = new Date();
      return {
        address,
        nonce: "stub-nonce",
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 60_000),
      };
    },
    async completeAuth(): Promise<CompleteAuthResult> {
      return { ok: true, result: { address } };
    },
  };
}

async function loginViaSiwe(
  app: FastifyInstance,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<string> {
  const nonceResponse = await app.inject({
    method: "POST",
    url: "/auth/nonce",
    payload: { address: account.address },
  });
  const { nonce, issuedAt, expiresAt } = nonceResponse.json();
  const message = buildSignInMessage({
    domain: "localhost",
    address: account.address,
    nonce,
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(expiresAt),
  });
  const signature = await account.signMessage({ message });
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { address: account.address, signature, nonce },
  });
  return extractSessionCookie(verifyResponse.headers["set-cookie"]);
}

async function loginViaStubPrivy(app: FastifyInstance, address: string): Promise<string> {
  // A fake but well-formed-looking access token — the stub provider never
  // inspects it, but a non-empty string satisfies the route's schema.
  const fakeAccessToken = ["stub", "privy", "access", "token"].join("-");
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/verify/privy",
    payload: { address, accessToken: fakeAccessToken },
  });
  return extractSessionCookie(verifyResponse.headers["set-cookie"]);
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /session_token=([^;]+)/.exec(String(header));
  if (!match?.[1]) throw new Error("no session_token cookie in response");
  return match[1];
}

runIfOptedIn("Identity provider migration / rollback (integration, T-1602, AC-1603)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
  });

  it(
    "an address's Agent/task history stays correctly associated after switching to a " +
      "different IdentityProvider, and after that provider is later removed from the " +
      "composition root (config rollback to pure SIWE) — real HTTP, real DB, real SIWE " +
      "signature throughout",
    async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const address = account.address.toLowerCase();

      // Step 1 — real SIWE login (T-1600's existing, unmodified path).
      const appWithBothProviders = buildApp({
        pool,
        privyIdentityProvider: fixedAddressStubProvider(account.address),
      });
      const siweCookie = await loginViaSiwe(appWithBothProviders, account);
      expect(siweCookie).toBeTruthy();

      // Step 2 — create an Agent and a Task owned by this address, via the
      // real routes, under the real SIWE-issued session.
      const agentResponse = await appWithBothProviders.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: siweCookie },
        payload: {
          name: "T-1602 迁移验证 Agent",
          description: "用于验证跨 provider 数据关联的测试 Agent。",
          category: "writing",
          skillTags: ["copywriting"],
          payoutAddress: account.address,
          pricingType: "FREE",
          credentialEnabled: false,
        },
      });
      expect(agentResponse.statusCode).toBe(201);
      const { agentId } = agentResponse.json();

      const taskResponse = await appWithBothProviders.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: siweCookie },
        payload: {
          category: "writing",
          skillTags: ["copywriting"],
          title: "T-1602 迁移验证 Task",
          description: "用于验证跨 provider 数据关联的测试任务。",
          budget: "1000000000000000000",
          deliveryDeadline: "2099-01-01T00:00:00.000Z",
          expertType: "CONTENT_GENERATION",
        },
      });
      expect(taskResponse.statusCode).toBe(201);
      const { taskId } = taskResponse.json();

      // Step 3 — the SAME address authenticates through a DIFFERENT
      // IdentityProvider (the stub, standing in for a real second
      // implementation — see file header for why this is the correct
      // real test of AC-1603's actual claim). A brand new session is
      // issued; this is a different session_token than siweCookie.
      const privyCookie = await loginViaStubPrivy(appWithBothProviders, account.address);
      expect(privyCookie).toBeTruthy();
      expect(privyCookie).not.toBe(siweCookie);

      // Step 4 — under the Privy-issued session, the SIWE-created Agent
      // and Task are still visible with identical ownership/fields. This
      // is the real assertion: our own data model never recorded which
      // provider authenticated the session that created these rows, only
      // the address — so a later session from a different provider for
      // the same address sees exactly the same data.
      const agentAfterSwitch = await appWithBothProviders.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: privyCookie },
      });
      expect(agentAfterSwitch.statusCode).toBe(200);
      const agentAfterSwitchBody = agentAfterSwitch.json();
      expect(agentAfterSwitchBody.name).toBe("T-1602 迁移验证 Agent");
      // credentialRef (owner-only field) being present at all — rather
      // than omitted — proves the server resolved this session's address
      // as the OWNER of this Agent, not merely "some valid session".
      expect(Object.prototype.hasOwnProperty.call(agentAfterSwitchBody, "credentialRef")).toBe(
        true,
      );

      const taskAfterSwitch = await appWithBothProviders.inject({
        method: "GET",
        url: `/tasks/${taskId}`,
        cookies: { session_token: privyCookie },
      });
      expect(taskAfterSwitch.statusCode).toBe(200);
      expect(taskAfterSwitch.json().title).toBe("T-1602 迁移验证 Task");

      // Step 5 — rollback: simulating PRIVY_APP_ID/PRIVY_APP_SECRET having
      // been removed from the environment (F-1603's real rollback
      // scenario). Passing `privyIdentityProvider: undefined` to
      // `buildApp` does NOT achieve this on its own — `options.
      // privyIdentityProvider ?? createPrivyIdentityProvider()` treats an
      // explicit `undefined` exactly like an omitted option, so it falls
      // through to the real factory, which reads this worktree's actual
      // `.env` and finds real credentials still set. There is no separate
      // "env" seam (see `privy-routes.integration.test.ts`'s own
      // graceful-degradation test, which hits the identical limitation) —
      // the only way to genuinely exercise "credentials absent" is to
      // temporarily delete the real env vars, restored in `finally` so no
      // other test in this file/worker observes them missing.
      const savedAppId = process.env.PRIVY_APP_ID;
      const savedAppSecret = process.env.PRIVY_APP_SECRET;
      delete process.env.PRIVY_APP_ID;
      delete process.env.PRIVY_APP_SECRET;

      let rolledBackApp: FastifyInstance;
      let siweCookieAfterRollback: string;
      try {
        rolledBackApp = buildApp({ pool });

        const privyRouteAfterRollback = await rolledBackApp.inject({
          method: "POST",
          url: "/auth/verify/privy",
          payload: {
            address: account.address,
            accessToken: ["irrelevant", "route", "is", "gone"].join("-"),
          },
        });
        expect(privyRouteAfterRollback.statusCode).toBe(404);

        siweCookieAfterRollback = await loginViaSiwe(rolledBackApp, account);
        expect(siweCookieAfterRollback).toBeTruthy();
      } finally {
        if (savedAppId === undefined) delete process.env.PRIVY_APP_ID;
        else process.env.PRIVY_APP_ID = savedAppId;
        if (savedAppSecret === undefined) delete process.env.PRIVY_APP_SECRET;
        else process.env.PRIVY_APP_SECRET = savedAppSecret;
      }

      const agentAfterRollback = await rolledBackApp.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: siweCookieAfterRollback },
      });
      expect(agentAfterRollback.statusCode).toBe(200);
      expect(agentAfterRollback.json().name).toBe("T-1602 迁移验证 Agent");
      expect(Object.prototype.hasOwnProperty.call(agentAfterRollback.json(), "credentialRef")).toBe(
        true,
      );

      const taskAfterRollback = await rolledBackApp.inject({
        method: "GET",
        url: `/tasks/${taskId}`,
        cookies: { session_token: siweCookieAfterRollback },
      });
      expect(taskAfterRollback.statusCode).toBe(200);
      expect(taskAfterRollback.json().title).toBe("T-1602 迁移验证 Task");

      // Sanity: every session issued above really did resolve to the
      // SAME normalized address at the database level — the actual
      // "identity did not fragment across providers" claim, checked
      // directly rather than only inferred from HTTP behavior.
      const { rows: userRows } = await pool.query<{ address: string }>(
        "SELECT address FROM users WHERE address = $1",
        [address],
      );
      expect(userRows).toHaveLength(1);
      const { rows: agentRows } = await pool.query<{ owner_address: string }>(
        "SELECT owner_address FROM agents WHERE id = $1",
        [agentId],
      );
      expect(agentRows[0]?.owner_address).toBe(address);
    },
  );
});
