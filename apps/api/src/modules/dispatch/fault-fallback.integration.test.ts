import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * F-1913/AC-1908 (T-1909): "Python 重排服务不可用、超时或返回明显异常结果
 * 时，自动回退到 Go 现有 v0.2 确定性分发...不阻断撮合主流程". This is
 * mechanically already guaranteed BY CONSTRUCTION today — `matchTask`'s
 * response is built entirely from Go's `matchResponse` BEFORE
 * `runShadowRerank` is ever called (routes.ts), and `runShadowRerank`
 * itself never throws (its own doc comment) — but that guarantee has never
 * been proven end-to-end with Python GENUINELY unreachable (as opposed to
 * `rerank-client.integration.test.ts`'s own "ERROR on unreachable service"
 * test, which only proves `callRerankService`'s own return value, not that
 * a REAL `/match` HTTP request still succeeds all the way through).
 *
 * Deliberately does NOT require a running `dispatch-rerank` service (unlike
 * `shadow-rerank.integration.test.ts`, gated behind
 * `RUN_DISPATCH_RERANK_INTEGRATION_TESTS=1`) — the whole point is Python
 * being unreachable, so this suite only needs `RUN_DB_INTEGRATION_TESTS=1`
 * and runs in the same fast tier as `routes.integration.test.ts`.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const callMatchMock = vi.fn();
vi.mock("./dispatch.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dispatch.client.js")>();
  return {
    ...actual,
    callMatch: (...args: Parameters<typeof actual.callMatch>) => callMatchMock(...args),
  };
});

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn(
  "F-1913/AC-1908 fault fallback: /match succeeds via Go even when dispatch-rerank is unreachable (integration, T-1909)",
  () => {
    let pool: Pool;
    let app: Awaited<ReturnType<typeof buildApp>>;
    const requester = privateKeyToAccount(generatePrivateKey());
    const signerPrivateKey = generatePrivateKey();
    const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = [
      "ACCEPTANCE_PERMIT_SIGNER_KEY",
      "CHAIN_ID",
      "TASK_ESCROW_ADDRESS",
      "YD_TOKEN_ADDRESS",
      "YD_FAUCET_ADDRESS",
      "DISPATCH_RERANK_URL",
      "DISPATCH_RERANK_TIMEOUT_MS",
    ];

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });

      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
      }
      process.env.ACCEPTANCE_PERMIT_SIGNER_KEY = signerPrivateKey;
      process.env.CHAIN_ID = "31337";
      process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
      process.env.YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      process.env.YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
      // A port nothing listens on — a real connection-refused error, not a
      // mock. A short timeout keeps this test fast (this test's whole
      // point is proving the FALLBACK, not measuring real timeout latency
      // — `rerank-client.ts`'s own timeout behavior is already covered by
      // `rerank-client.integration.test.ts`).
      process.env.DISPATCH_RERANK_URL = "http://127.0.0.1:1";
      process.env.DISPATCH_RERANK_TIMEOUT_MS = "2000";
    });

    afterAll(async () => {
      await app.close();
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    async function login(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
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
      const setCookie = verifyResponse.headers["set-cookie"];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const match = /session_token=([^;]+)/.exec(String(header));
      if (!match?.[1]) throw new Error("no session_token cookie in verify response");
      return match[1];
    }

    async function insertOpenTask(requesterAddress: string): Promise<string> {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        requesterAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'write a landing page', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
        [requesterAddress, TOKEN_ADDRESS],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertOpenTask: no id returned");
      return id;
    }

    async function insertActiveAgent(): Promise<string> {
      const ownerAddress = "0x9983fefc63f0cd0e873a0000c6d07ef7b77e90d8";
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        ownerAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
        [ownerAddress],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertActiveAgent: no id returned");
      return id;
    }

    it(
      "returns Go's real result with 200 even though dispatch-rerank is completely unreachable, and records the failure honestly",
      async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentId = await insertActiveAgent();
        const token = await login(requester);

        callMatchMock.mockResolvedValue({
          taskId,
          algorithmVersion: "v0.1",
          recommendations: [
            { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配"] },
          ],
        });

        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/match`,
          cookies: { session_token: token },
        });

        // AC-1908: the match request itself succeeds and returns Go's real
        // result, completely unaffected by Python being down.
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          taskId,
          algorithmVersion: "v0.1",
          recommendationCount: 1,
        });

        // F-1913: the failure is still honestly recorded — this is a real
        // ERROR, not silently swallowed without a trace.
        const { rows } = await pool.query<{
          outcome: string;
          adopted: boolean;
          rerank_service_version: string;
        }>(
          `SELECT drr.outcome, drr.adopted, drr.rerank_service_version
         FROM dispatch_rerank_runs drr
         JOIN recommendation_runs rr ON rr.id = drr.run_id
         WHERE rr.task_id = $1`,
          [taskId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.outcome).toBe("ERROR");
        expect(rows[0]?.adopted).toBe(false);
        expect(rows[0]?.rerank_service_version).toBe("unavailable");

        // No real ranking was ever produced, so there is nothing for
        // shadow_ranking_results to hold (shadow-rerank.ts's own N4-fixed
        // "only a real response gets a shadow row" rule).
        const shadowRows = await pool.query(
          `SELECT srr.id FROM shadow_ranking_results srr
         JOIN recommendation_runs rr ON rr.id = srr.run_id
         WHERE rr.task_id = $1`,
          [taskId],
        );
        expect(shadowRows.rows).toHaveLength(0);
      },
      { timeout: 15_000 },
    );
  },
);
