import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { computeEmbeddingVersion } from "../embeddings/embed-on-save.js";
import { OllamaEmbeddingProvider } from "../embeddings/ollama-provider.js";
import { upsertKbArticleByTitle } from "./kb-repository.js";

/**
 * Feature 22 (ai-customer-service), T-2204 (F-2205). The real end-to-end
 * proof that persistence + escalation actually work TOGETHER — not just
 * `generateAnswer` in isolation (answer-generator.test.ts/
 * answer-generator.integration.test.ts already cover that) and not just
 * each repository function in isolation.
 *
 * Real Postgres (gated by RUN_DB_INTEGRATION_TESTS=1, same convention as
 * every other *.integration.test.ts in this codebase) + a FAKE local HTTP
 * server standing in for Ollama (same technique
 * answer-generator.test.ts/intent-classifier.test.ts already established)
 * — no real Ollama daemon required to run this file. A genuinely-real
 * Ollama+Postgres chain is a materially different, slower gate
 * (RUN_OLLAMA_INTEGRATION_TESTS=1 in intent-classifier.integration.test.ts/
 * answer-generator.integration.test.ts); this file's job is proving the
 * ROUTES' own persistence/escalation/permission wiring is correct, which a
 * fake model backend already exercises faithfully (every DB write this
 * file asserts on is real).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

const ARTICLE_TITLE = "验收窗口是多久";
const ARTICLE_CONTENT = "验收窗口从提交成果时开始计算，需求方需要在验收窗口内完成验收或发起争议。";

function makeVector(dimension: number): number[] {
  return Array.from({ length: dimension }, () => 0.1);
}

runIfOptedIn("customer-service routes (integration, T-2204)", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let server: Server;
  let baseUrl: string;
  let intentResponder: () => unknown;
  let answerResponder: () => unknown;
  let articleId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);

    intentResponder = () => ({ intent: "PLATFORM_USAGE", rationale: "平台规则问题" });
    answerResponder = () => ({
      answerable: true,
      answer: "验收窗口从提交成果时开始计算。",
      citedArticleIds: [articleId],
    });

    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "GET" && req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: "bge-m3:latest", digest: "digest-abc" }] }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/embed") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings: [makeVector(1024)] }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/generate") {
          const body = raw ? (JSON.parse(raw) as { prompt: string }) : { prompt: "" };
          if (body.prompt.includes("客服意图分类助手")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response: JSON.stringify(intentResponder()) }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ response: JSON.stringify(answerResponder()) }));
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
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.OLLAMA_BASE_URL = baseUrl;

    // Seed one real KB article via the real embedding pipeline against the
    // fake server, exactly the way seed-kb-articles.ts does — needed for
    // `generateAnswer`'s real `searchKbArticles` call to have something to
    // find above the similarity floor.
    const provider = new OllamaEmbeddingProvider(pool);
    const identity = await provider.resolveVersionIdentity();
    const embeddingVersion = computeEmbeddingVersion(identity);
    const embedded = await provider.embed(ARTICLE_CONTENT);
    await upsertKbArticleByTitle(pool, {
      title: ARTICLE_TITLE,
      content: ARTICLE_CONTENT,
      embedding: embedded.vector,
      provider: identity.provider,
      model: identity.model,
      dimension: identity.dimension,
      embeddingVersion,
    });
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM kb_articles WHERE title = $1`,
      [ARTICLE_TITLE],
    );
    articleId = rows[0]?.id ?? "";

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

  async function createAnonymousConversation(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/customer-service/conversations",
      payload: { sessionId: "anon-session" },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { conversation: { id: string } }).conversation.id;
  }

  const admin = privateKeyToAccount(generatePrivateKey());
  const ownerUser = privateKeyToAccount(generatePrivateKey());
  const otherUser = privateKeyToAccount(generatePrivateKey());

  it("a real message round-trip persists both messages and returns real KB-grounded citations", async () => {
    intentResponder = () => ({ intent: "PLATFORM_USAGE" });
    answerResponder = () => ({
      answerable: true,
      answer: "验收窗口从提交成果时开始计算。",
      citedArticleIds: [articleId],
    });

    const conversationId = await createAnonymousConversation();

    const messageResponse = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "验收窗口是多久？" },
    });
    expect(messageResponse.statusCode).toBe(200);
    const body = messageResponse.json() as {
      intent: string;
      answer: string;
      citedKbArticleIds: string[];
      escalated: boolean;
    };
    expect(body.escalated).toBe(false);
    expect(body.citedKbArticleIds).toEqual([articleId]);

    const { rows: messages } = await pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM customer_service_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("USER");
    expect(messages[0]?.content).toBe("验收窗口是多久？");
    expect(messages[1]?.role).toBe("ASSISTANT");

    const { rows: conversations } = await pool.query<{
      intent: string | null;
      escalated_to_human: boolean;
    }>(`SELECT intent, escalated_to_human FROM customer_service_conversations WHERE id = $1`, [
      conversationId,
    ]);
    expect(conversations[0]?.intent).toBe("PLATFORM_USAGE");
    expect(conversations[0]?.escalated_to_human).toBe(false);
  });

  it("an UNHANDLED classification marks the conversation escalated via the message endpoint itself", async () => {
    intentResponder = () => ({ intent: "UNHANDLED" });

    const conversationId = await createAnonymousConversation();
    const response = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "帮我预测一下比特币明天的价格" },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { escalated: boolean }).escalated).toBe(true);

    const { rows } = await pool.query<{ escalated_to_human: boolean }>(
      `SELECT escalated_to_human FROM customer_service_conversations WHERE id = $1`,
      [conversationId],
    );
    expect(rows[0]?.escalated_to_human).toBe(true);
  });

  it("F-2205: the explicit escalate endpoint marks an anonymous conversation escalated", async () => {
    const conversationId = await createAnonymousConversation();

    const response = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/escalate`,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { escalated: boolean }).escalated).toBe(true);

    const { rows } = await pool.query<{ escalated_to_human: boolean }>(
      `SELECT escalated_to_human FROM customer_service_conversations WHERE id = $1`,
      [conversationId],
    );
    expect(rows[0]?.escalated_to_human).toBe(true);
  });

  it("rejects escalating an unknown conversation id with 404", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/customer-service/conversations/11111111-1111-4111-8111-111111111111/escalate",
    });
    expect(response.statusCode).toBe(404);
  });

  it("an anonymous session's conversation cannot be escalated by a different logged-in actor", async () => {
    const conversationId = await createAnonymousConversation();
    const otherToken = await login(otherUser);

    const response = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/escalate`,
      cookies: { session_token: otherToken },
    });
    expect(response.statusCode).toBe(403);

    const { rows } = await pool.query<{ escalated_to_human: boolean }>(
      `SELECT escalated_to_human FROM customer_service_conversations WHERE id = $1`,
      [conversationId],
    );
    expect(rows[0]?.escalated_to_human).toBe(false);
  });

  it("a logged-in caller cannot escalate a different logged-in caller's own conversation", async () => {
    const ownerToken = await login(ownerUser);
    const createResponse = await app.inject({
      method: "POST",
      url: "/customer-service/conversations",
      cookies: { session_token: ownerToken },
      payload: { sessionId: "owner-session" },
    });
    const conversationId = (createResponse.json() as { conversation: { id: string } }).conversation
      .id;

    const otherToken = await login(otherUser);
    const response = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/escalate`,
      cookies: { session_token: otherToken },
    });
    expect(response.statusCode).toBe(403);
  });

  it("the owning logged-in caller CAN escalate their own conversation", async () => {
    const ownerToken = await login(ownerUser);
    const createResponse = await app.inject({
      method: "POST",
      url: "/customer-service/conversations",
      cookies: { session_token: ownerToken },
      payload: { sessionId: "owner-session" },
    });
    const conversationId = (createResponse.json() as { conversation: { id: string } }).conversation
      .id;

    const response = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/escalate`,
      cookies: { session_token: ownerToken },
    });
    expect(response.statusCode).toBe(200);
  });

  it("AC: a non-admin gets 403 and an unauthenticated caller gets 401 from the admin queue endpoint", async () => {
    await seedAdmin(admin.address);
    const nonAdminToken = await login(otherUser);

    const nonAdminResponse = await app.inject({
      method: "GET",
      url: "/admin/customer-service/conversations",
      cookies: { session_token: nonAdminToken },
    });
    expect(nonAdminResponse.statusCode).toBe(403);

    const unauthenticatedResponse = await app.inject({
      method: "GET",
      url: "/admin/customer-service/conversations",
    });
    expect(unauthenticatedResponse.statusCode).toBe(401);
  });

  it("the admin queue lists escalated conversations, and the messages endpoint returns the real, complete, ordered transcript", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    intentResponder = () => ({ intent: "UNHANDLED" });
    const conversationId = await createAnonymousConversation();
    await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "第一条消息" },
    });
    await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "第二条消息" },
    });

    const queueResponse = await app.inject({
      method: "GET",
      url: "/admin/customer-service/conversations",
      cookies: { session_token: adminToken },
    });
    expect(queueResponse.statusCode).toBe(200);
    const queue = (
      queueResponse.json() as { conversations: { id: string; escalatedToHuman: boolean }[] }
    ).conversations;
    expect(queue.some((c) => c.id === conversationId && c.escalatedToHuman)).toBe(true);

    const messagesResponse = await app.inject({
      method: "GET",
      url: `/admin/customer-service/conversations/${conversationId}/messages`,
      cookies: { session_token: adminToken },
    });
    expect(messagesResponse.statusCode).toBe(200);
    const messagesBody = messagesResponse.json() as {
      messages: { role: string; content: string }[];
    };
    // 2 real user messages + 2 real assistant replies = 4, in order.
    expect(messagesBody.messages).toHaveLength(4);
    expect(messagesBody.messages[0]).toMatchObject({ role: "USER", content: "第一条消息" });
    expect(messagesBody.messages[1]?.role).toBe("ASSISTANT");
    expect(messagesBody.messages[2]).toMatchObject({ role: "USER", content: "第二条消息" });
    expect(messagesBody.messages[3]?.role).toBe("ASSISTANT");
  });

  it("N4 P1 fix: the admin queue is cursor-paginated so an older escalated conversation is never permanently hidden", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);
    intentResponder = () => ({ intent: "UNHANDLED" });

    const conversationIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const conversationId = await createAnonymousConversation();
      await app.inject({
        method: "POST",
        url: `/customer-service/conversations/${conversationId}/messages`,
        payload: { message: `消息 ${i}` },
      });
      conversationIds.push(conversationId);
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/admin/customer-service/conversations?limit=2",
      cookies: { session_token: adminToken },
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as {
      conversations: { id: string }[];
      nextCursor: { createdAt: string; id: string } | null;
    };
    expect(firstBody.conversations).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const cursor = firstBody.nextCursor;
    if (!cursor) {
      throw new Error("expected a real nextCursor from the first page");
    }

    const secondPage = await app.inject({
      method: "GET",
      url: `/admin/customer-service/conversations?limit=2&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`,
      cookies: { session_token: adminToken },
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json() as { conversations: { id: string }[] };
    // The oldest of the 3 real conversations must appear on the SECOND
    // page — never dropped, and never duplicated with the first page.
    const allIds = [...firstBody.conversations, ...secondBody.conversations].map((c) => c.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toContain(conversationIds[0]);
  });

  it("N4 P1 fix (round 2): an admin can actually reply to a conversation, and the reply appears in the real transcript", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);
    intentResponder = () => ({ intent: "UNHANDLED" });

    const conversationId = await createAnonymousConversation();
    await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "有个问题机器人回答不了" },
    });

    const replyResponse = await app.inject({
      method: "POST",
      url: `/admin/customer-service/conversations/${conversationId}/reply`,
      cookies: { session_token: adminToken },
      payload: { message: "你好，我是人工客服，我来帮你处理。" },
    });
    expect(replyResponse.statusCode).toBe(201);

    const nonAdminReplyResponse = await app.inject({
      method: "POST",
      url: `/admin/customer-service/conversations/${conversationId}/reply`,
      payload: { message: "冒充人工客服" },
    });
    expect(nonAdminReplyResponse.statusCode).toBe(401);

    const messagesResponse = await app.inject({
      method: "GET",
      url: `/admin/customer-service/conversations/${conversationId}/messages`,
      cookies: { session_token: adminToken },
    });
    const messagesBody = messagesResponse.json() as {
      conversation: { escalatedToHuman: boolean };
      messages: { role: string; content: string }[];
    };
    expect(messagesBody.conversation.escalatedToHuman).toBe(true);
    const humanMessage = messagesBody.messages.find((m) => m.role === "HUMAN_AGENT");
    expect(humanMessage?.content).toBe("你好，我是人工客服，我来帮你处理。");
  });

  it("N4 P2 fix (round 2): a conversation already escalated stays reported as escalated even when a later message is auto-answerable", async () => {
    intentResponder = () => ({ intent: "UNHANDLED" });
    const conversationId = await createAnonymousConversation();
    const firstResponse = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "第一条，触发升级" },
    });
    expect((firstResponse.json() as { escalated: boolean }).escalated).toBe(true);

    // The SAME conversation now gets a confidently-answerable message —
    // `generateAnswer` itself would say `escalate: false` for this turn,
    // but the conversation's real persisted state is still escalated.
    intentResponder = () => ({ intent: "PLATFORM_USAGE", rationale: "可以直接回答" });
    const secondResponse = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "第二条，机器人本可以回答" },
    });
    expect((secondResponse.json() as { escalated: boolean }).escalated).toBe(true);
  });

  // A genuinely SEPARATE app instance (same real pool/migrations, no new
  // DB state) rather than the shared `app` every other test in this file
  // uses — `@fastify/rate-limit`'s counters live in that instance's own
  // in-memory store, and every other test here also POSTs against the
  // rate-limited routes, so sharing `app` would make this test's real
  // pass/fail depend on how many requests every OTHER test already made
  // (order-dependent flakiness, not a real assertion). A fresh instance
  // gives this test its own real, isolated 30-requests/minute budget.
  it("N4 P1 fix: rate-limits repeated message sends from the same (anonymous) caller", async () => {
    const isolatedApp = buildApp({ pool });
    await isolatedApp.ready();
    try {
      const createResponse = await isolatedApp.inject({
        method: "POST",
        url: "/customer-service/conversations",
        payload: { sessionId: "rate-limit-test-session" },
      });
      const conversationId = (createResponse.json() as { conversation: { id: string } })
        .conversation.id;

      let sawRateLimited = false;
      for (let i = 0; i < 40; i += 1) {
        const response = await isolatedApp.inject({
          method: "POST",
          url: `/customer-service/conversations/${conversationId}/messages`,
          payload: { message: `第 ${i} 条` },
        });
        if (response.statusCode === 429) {
          sawRateLimited = true;
          break;
        }
      }
      expect(sawRateLimited).toBe(true);
    } finally {
      await isolatedApp.close();
    }
  });
});
