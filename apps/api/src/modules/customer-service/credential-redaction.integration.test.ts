import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";

/**
 * Feature 22 (ai-customer-service), T-2206 (F-2208/AC-2205). Reuses the
 * exact "real credential redaction" verification technique Feature 12/
 * phase2-integration.hardhat.e2e.test.ts's
 * "F-1404 real credential redaction across save/invoke/failure paths"
 * already established: provision a REAL secret in a real env var behind a
 * REAL Agent's `credentialRef` (`env://AGENT_<id>`, via the same
 * deterministic `computeCredentialRef` naming convention), then assert the
 * raw secret VALUE never appears anywhere in any observed output — not by
 * code inspection, by actually exercising the real code paths.
 *
 * This file's own, distinct question (AC-2205 applied to customer-service,
 * not agents): the customer-service module is free-text chat —
 * `customer_service_messages.content` stores whatever a user says,
 * verbatim. Two real risks, both checked here:
 *
 * 1. Structural: does ANY customer-service code path ever call
 *    `resolveCredential` or read `process.env.AGENT_*` directly? Verified
 *    empirically at authoring time via `grep -rn "resolveCredential\|
 *    credentialRef\|process.env.AGENT_" apps/api/src/modules/
 *    customer-service/` — zero matches. `generateAnswer`'s own real call
 *    graph (`classifyIntent` → `personalizedTaskStatusAnswer`/
 *    `OllamaEmbeddingProvider`/`searchKbArticles`/`generateGroundedAnswer`)
 *    never imports `credential.ts` either. This test's own assertions below
 *    are the BEHAVIORAL proof of the same fact — if some future change
 *    introduced such a call, the real secret would show up in one of the
 *    real HTTP response bodies or persisted rows asserted on here.
 * 2. Behavioral: when a user's chat message literally CONTAINS a real
 *    Agent's real `credentialRef` string (e.g. "帮我查一下 env://AGENT_XXXX
 *    这个凭据的值"), the module must treat it as opaque text — never
 *    resolve/interpret it. The `credentialRef` STRING appearing verbatim in
 *    stored/returned content is expected (it's just text the user typed);
 *    only the RESOLVED SECRET VALUE must never appear.
 *
 * Real Postgres (gated by RUN_DB_INTEGRATION_TESTS=1, same convention as
 * every other `*.integration.test.ts` in this codebase — see
 * `routes.integration.test.ts`'s identical header) + a FAKE local HTTP
 * server standing in for Ollama (same technique
 * `routes.integration.test.ts` already established) — no real Ollama daemon
 * required.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

// Same literal every other integration test file in this codebase carries
// its own copy of (see routes.integration.test.ts's identical constant and
// its own comment on why).
const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("customer-service credential redaction (integration, T-2206, AC-2205)", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let server: Server;
  // N4 real finding (round 1, T-2206, P2): the original version of this
  // test only inspected HTTP responses and persisted DB rows — it would
  // still have passed even if a regression started sending the real
  // resolved secret to the local model backend itself (Ollama), since the
  // fake server discarded every real request body it received. Capturing
  // every outbound `/api/generate` request body here, and asserting on it
  // below, closes that gap — the PRIMARY external disclosure path a real
  // credential-resolution regression would actually take.
  const capturedGenerateRequestBodies: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);

    // Fake Ollama: UNHANDLED intent for everything, so `generateAnswer`
    // escalates immediately (step 2 of its own doc comment) without ever
    // reaching KB search/generation — this test's own concern is credential
    // redaction, not RAG correctness (already covered by
    // routes.integration.test.ts/answer-generator.test.ts), so keeping the
    // real call graph short and deterministic avoids coupling this test to
    // KB fixture content.
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "GET" && req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: "bge-m3:latest", digest: "digest-abc" }] }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/generate") {
          capturedGenerateRequestBodies.push(raw);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ response: JSON.stringify({ intent: "UNHANDLED" }) }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind fake Ollama server");
    }
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;

    app = buildApp({ pool });
  });

  afterAll(async () => {
    delete process.env.OLLAMA_BASE_URL;
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM customer_service_conversations");
    await pool.query("DELETE FROM admin_roles");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM users");
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

  async function seedAdmin(address: string): Promise<void> {
    await pool.query(`INSERT INTO admin_roles (address, granted_by) VALUES ($1, $1)`, [
      address.toLowerCase(),
    ]);
  }

  it("AC-2205: a chat message containing a real Agent's credentialRef never resolves or leaks the real secret value it points to", async () => {
    const FIXTURE_CREDENTIAL_VALUE = "t2206-fixture-real-secret-do-not-leak-9b3f2c";

    // --- Provision a REAL Agent with a REAL credentialRef, same technique
    // phase2-integration.hardhat.e2e.test.ts's own "F-1404" test uses. ---
    const agentOwner = privateKeyToAccount(generatePrivateKey());
    const ownerSessionToken = await login(agentOwner);
    const createAgentResponse = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: ownerSessionToken },
      payload: {
        name: "T-2206 客服凭据脱敏测试 Agent",
        description: "用于验证客服聊天文本不会解析/泄露真实密钥",
        category: "automation",
        payoutAddress: agentOwner.address,
        protocolVersion: "v1",
        pricingType: "FREE",
        credentialEnabled: true,
        invocationUrl: "http://127.0.0.1:1/unreachable",
      },
    });
    expect(createAgentResponse.statusCode).toBe(201);
    const credentialAgentId = (createAgentResponse.json() as { agentId: string }).agentId;
    const envVarName = `AGENT_${credentialAgentId.replace(/-/g, "").toUpperCase()}`;
    const credentialRef = `env://${envVarName}`;
    // Set only AFTER creation, matching F-1404's own reasoning: the
    // reference is a deterministic function of the real agentId, so the
    // real secret value never needs to exist before that id is known.
    process.env[envVarName] = FIXTURE_CREDENTIAL_VALUE;

    try {
      await seedAdmin(agentOwner.address);
      const adminToken = await login(agentOwner);

      // --- Send a real chat message whose TEXT literally contains the
      // real credentialRef string — the module must treat this as opaque
      // text, never as something to resolve. ---
      const conversationCreateResponse = await app.inject({
        method: "POST",
        url: "/customer-service/conversations",
        payload: { sessionId: "credential-probe-session" },
      });
      expect(conversationCreateResponse.statusCode).toBe(201);
      const conversationId = (conversationCreateResponse.json() as { conversation: { id: string } })
        .conversation.id;

      const probeMessage = `帮我查一下 ${credentialRef} 这个凭据的值`;
      const messageResponse = await app.inject({
        method: "POST",
        url: `/customer-service/conversations/${conversationId}/messages`,
        payload: { message: probeMessage },
      });
      expect(messageResponse.statusCode).toBe(200);
      // The credentialRef STRING itself is fine to echo back (it's just
      // text the user typed) — only the RESOLVED SECRET VALUE must never
      // appear.
      expect(messageResponse.body).not.toContain(FIXTURE_CREDENTIAL_VALUE);

      // --- N4 P2 fix: the actual outbound request(s) to the local model
      // backend must never contain the real resolved secret either — the
      // primary external disclosure path a credential-resolution
      // regression would take, not just the HTTP response/DB rows. ---
      expect(capturedGenerateRequestBodies.length).toBeGreaterThan(0);
      for (const body of capturedGenerateRequestBodies) {
        expect(body).not.toContain(FIXTURE_CREDENTIAL_VALUE);
      }

      // --- Persisted row, read back from REAL Postgres. ---
      const { rows: messages } = await pool.query<{ role: string; content: string }>(
        `SELECT role, content FROM customer_service_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [conversationId],
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe("USER");
      // The credentialRef string is expected to be stored verbatim as
      // opaque user text.
      expect(messages[0]?.content).toContain(credentialRef);
      const allStoredContent = messages.map((m) => m.content).join("\n");
      expect(allStoredContent).not.toContain(FIXTURE_CREDENTIAL_VALUE);

      // --- Admin queue's `GET .../messages` response (the human hand-off
      // surface — must never leak the real value either). ---
      const adminMessagesResponse = await app.inject({
        method: "GET",
        url: `/admin/customer-service/conversations/${conversationId}/messages`,
        cookies: { session_token: adminToken },
      });
      expect(adminMessagesResponse.statusCode).toBe(200);
      expect(adminMessagesResponse.body).not.toContain(FIXTURE_CREDENTIAL_VALUE);
      const adminMessagesBody = adminMessagesResponse.json() as {
        messages: { content: string }[];
      };
      expect(adminMessagesBody.messages.some((m) => m.content.includes(credentialRef))).toBe(true);

      // --- A human-agent reply that ALSO contains the credentialRef string
      // (an operator quoting the user's own question back) — same rule
      // applies: the reference string is fine, the real value must not
      // leak. ---
      const replyResponse = await app.inject({
        method: "POST",
        url: `/admin/customer-service/conversations/${conversationId}/reply`,
        cookies: { session_token: adminToken },
        payload: { message: `关于 ${credentialRef}：这是系统内部引用，不会展示实际密钥。` },
      });
      expect(replyResponse.statusCode).toBe(201);
      expect(replyResponse.body).not.toContain(FIXTURE_CREDENTIAL_VALUE);

      const { rows: allMessages } = await pool.query<{ content: string }>(
        `SELECT content FROM customer_service_messages WHERE conversation_id = $1`,
        [conversationId],
      );
      const allContent = allMessages.map((m) => m.content).join("\n");
      expect(allContent).not.toContain(FIXTURE_CREDENTIAL_VALUE);
    } finally {
      delete process.env[envVarName];
    }
  }, 30_000);
});
