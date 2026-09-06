import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * AC-1909's own real end-to-end proof: a real `POST /tasks/:taskId/match`
 * call really reaches `services/dispatch-rerank` (Go is mocked here, same
 * as `routes.integration.test.ts`'s own established convention — this
 * suite's whole point is the Node↔Python leg specifically, not re-proving
 * Go's own contract), and a real `dispatch_rerank_runs` row is recorded
 * with a real `trace_id`/`rerank_service_version`.
 *
 * Deliberately a SEPARATE file from `routes.integration.test.ts`: that
 * file mocks `runShadowRerank` to a no-op specifically so its many fast
 * tests don't each incur a real tens-of-seconds local `qwen3:8b` call
 * (T-1911's own measured latency) — this file is the one place that
 * intentionally does NOT mock it.
 *
 * Run locally with the real service up:
 *   cd services/dispatch-rerank && uv run uvicorn app.main:app --port 8001
 *   RUN_DB_INTEGRATION_TESTS=1 RUN_DISPATCH_RERANK_INTEGRATION_TESTS=1 \
 *     TEST_DATABASE_URL=... pnpm --filter @agent-market/api test -- shadow-rerank
 */
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

const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" &&
  process.env.RUN_DISPATCH_RERANK_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn(
  "real Node -> Go(mocked) -> Python -> Node rerank chain (integration, T-1912, AC-1909)",
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
      "records a real dispatch_rerank_runs AND shadow_ranking_results row from a real Python /rerank call, without adopting it into the response",
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

        // AC-1905: the real response is Go's v0.2/v0.1 result, unaffected by
        // whatever Python did — SHADOW is never adopted.
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          taskId,
          algorithmVersion: "v0.1",
          recommendationCount: 1,
        });

        const { rows } = await pool.query<{
          id: string;
          stage: string;
          rerank_service_version: string;
          ranking_policy_version: string | null;
          outcome: string;
          adopted: boolean;
          trace_id: string;
          latency_ms: number;
        }>(
          `SELECT drr.id, drr.stage, drr.rerank_service_version, drr.ranking_policy_version, drr.outcome, drr.adopted, drr.trace_id, drr.latency_ms
         FROM dispatch_rerank_runs drr
         JOIN recommendation_runs rr ON rr.id = drr.run_id
         WHERE rr.task_id = $1`,
          [taskId],
        );
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row?.stage).toBe("SHADOW");
        expect(row?.adopted).toBe(false);
        expect(row?.ranking_policy_version).toBeNull();
        expect(["SUCCESS", "DEGRADED"]).toContain(row?.outcome);
        expect(row?.rerank_service_version).not.toBe("unavailable");
        expect(row?.trace_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(row?.latency_ms).toBeGreaterThan(0);

        // F-1906/AC-1905: the real point of the shadow stage — Python's
        // ranking and Go's real ranking are BOTH persisted for later
        // offline comparison (T-1905/T-1908), never used to change what
        // was already returned to the requester above.
        const shadowRows = await pool.query<{
          rerank_run_id: string;
          ctr_model_id: string | null;
          shadow_ranked_agent_ids: string[];
          real_ranked_agent_ids: string[];
        }>(
          `SELECT srr.rerank_run_id, srr.ctr_model_id, srr.shadow_ranked_agent_ids, srr.real_ranked_agent_ids
         FROM shadow_ranking_results srr
         JOIN recommendation_runs rr ON rr.id = srr.run_id
         WHERE rr.task_id = $1`,
          [taskId],
        );
        expect(shadowRows.rows).toHaveLength(1);
        const shadowRow = shadowRows.rows[0];
        expect(shadowRow?.rerank_run_id).toBe(row?.id);
        expect(shadowRow?.ctr_model_id).toBeNull();
        expect(shadowRow?.real_ranked_agent_ids).toEqual([agentId]);
        expect(shadowRow?.shadow_ranked_agent_ids).toEqual([agentId]);
      },
      { timeout: 95_000 },
    );
  },
);
