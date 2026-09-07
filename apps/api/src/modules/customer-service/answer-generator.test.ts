import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../../db/pool.js";
import { generateAnswer } from "./answer-generator.js";

/**
 * F-2202/T-2202: exercises the REAL `generateAnswer` pipeline (real
 * `classifyIntent`, real `OllamaEmbeddingProvider`, real `searchKbArticles`)
 * against one fake local HTTP server standing in for Ollama (same
 * technique `intent-classifier.test.ts`/`ai-scorer.test.ts` already
 * established) and one fake `Queryable` standing in for Postgres (same
 * technique `settlement-stats.test.ts` already established) — never a
 * mocked `generateAnswer` internal. The genuinely-real local
 * Ollama+Postgres chain lives in `answer-generator.integration.test.ts`,
 * gated behind `RUN_DB_INTEGRATION_TESTS=1`.
 */

const ARTICLE_ONE_ID = "11111111-1111-4111-8111-111111111111";
const ARTICLE_TWO_ID = "22222222-2222-4222-8222-222222222222";

function makeVector(dimension: number): number[] {
  return Array.from({ length: dimension }, () => 0.1);
}

function kbRow(id: string, title: string, content: string, similarity: number) {
  return {
    id,
    title,
    content,
    provider: "ollama",
    model: "bge-m3:latest",
    dimension: 1024,
    embedding_version: "ollama:bge-m3:latest@digest:dim1024:tmplv1",
    updated_at: new Date(),
    similarity,
  };
}

/** T-2203: a row shaped like `listTasks`'s (repository.ts) real
 * `TaskListQueryRow` — the exact columns its `SELECT` actually returns —
 * so `buildFakePool`'s stand-in for `tasks`/`listTasksForMarket` stays
 * consistent with the real query shape rather than inventing a different
 * fake-row convention. */
function taskRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-000000000001",
    requester_address: "0x1111111111111111111111111111111111111111",
    category: "writing",
    title: "写一份产品文案",
    description: "详情",
    budget: "100000000000000000000",
    token: "USDC",
    delivery_deadline: new Date("2099-01-01T00:00:00.000Z"),
    status: "OPEN",
    funding_tx_hash: null,
    idempotency_key: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    accepted_agent_address: null,
    accepted_at: null,
    skill_tags: [],
    ...overrides,
  };
}

interface FakePoolControls {
  pool: Queryable;
  kbRows: ReturnType<typeof kbRow>[];
  taskRows: Record<string, unknown>[];
  queryCalls: { sql: string; params: unknown[] }[];
}

function buildFakePool(): FakePoolControls {
  const kbRows: ReturnType<typeof kbRow>[] = [];
  const taskRows: Record<string, unknown>[] = [];
  const queryCalls: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    if (sql.includes("embedding_budget_usage")) {
      return { rows: [{ call_count: 1 }] };
    }
    if (sql.includes("kb_articles")) {
      return { rows: kbRows };
    }
    // `listTasks` (tasks/repository.ts) issues two queries against `tasks`:
    // an item-list SELECT and a separate `count(*)` — matched here by their
    // distinguishing text, same disambiguation technique this file already
    // uses to tell the intent-classification prompt apart from the
    // answer-generation prompt above.
    if (sql.includes("count(*)::text AS total FROM tasks")) {
      return { rows: [{ total: String(taskRows.length) }] };
    }
    if (sql.includes("FROM tasks")) {
      return { rows: taskRows };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as Queryable, kbRows, taskRows, queryCalls };
}

describe("generateAnswer (F-2202/T-2202)", () => {
  let server: Server;
  let baseUrl: string;
  let intentResponder: () => unknown;
  let answerResponder: () => { status: number; body: unknown };
  let embedCallCount: number;
  let generateCallCount: number;

  beforeEach(async () => {
    embedCallCount = 0;
    generateCallCount = 0;
    intentResponder = () => ({ intent: "TASK_STATUS", rationale: "查询任务状态" });
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: true,
          answer: "验收窗口从提交成果时开始计算。",
          citedArticleIds: [ARTICLE_ONE_ID],
        }),
      },
    });

    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "GET" && req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              models: [{ name: "bge-m3:latest", digest: "digest-abc" }],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/api/embed") {
          embedCallCount += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings: [makeVector(1024)] }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/generate") {
          const body = raw ? (JSON.parse(raw) as { prompt: string }) : { prompt: "" };
          // Disambiguate classification vs. answer-generation calls by the
          // distinguishing marker text each module's own prompt builder
          // writes — same idea as intent-classifier.test.ts's own
          // request-body inspection, extended to route between two
          // different real prompt templates hitting the same endpoint.
          if (body.prompt.includes("客服意图分类助手")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response: JSON.stringify(intentResponder()) }));
            return;
          }
          generateCallCount += 1;
          const { status, body: responseBody } = answerResponder();
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseBody));
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
  });

  afterEach(async () => {
    delete process.env.OLLAMA_BASE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("UNHANDLED intent short-circuits before any KB search or embedding call", async () => {
    intentResponder = () => ({ intent: "UNHANDLED" });
    const { pool, queryCalls } = buildFakePool();

    const result = await generateAnswer(pool, "帮我预测一下比特币明天的价格", null);

    expect(result.escalate).toBe(true);
    expect(result.intent).toBe("UNHANDLED");
    expect(result.citedKbArticleIds).toEqual([]);
    expect(embedCallCount).toBe(0);
    expect(generateCallCount).toBe(0);
    expect(queryCalls).toHaveLength(0);
  });

  it("a classification failure (IntentClassifierError) escalates without any KB search", async () => {
    // Force a classification failure: an out-of-enum intent value that
    // classifyIntent's own z.enum boundary rejects.
    intentResponder = () => ({ intent: "SOMETHING_ELSE" });
    const { pool } = buildFakePool();

    const result = await generateAnswer(pool, "这是什么问题", null);

    expect(result.escalate).toBe(true);
    expect(result.intent).toBe("UNHANDLED");
    expect(embedCallCount).toBe(0);
    expect(generateCallCount).toBe(0);
  });

  it("zero KB matches above the similarity floor returns the honest uncertain answer without calling generation", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "任务取消规则", "内容", 0.1)); // below SIMILARITY_FLOOR

    const result = await generateAnswer(pool, "帮我预测一下比特币明天的价格", null);

    expect(result.escalate).toBe(true);
    expect(result.citedKbArticleIds).toEqual([]);
    expect(result.answer).toContain("转接人工");
    expect(generateCallCount).toBe(0);
    expect(embedCallCount).toBe(1); // embedding WAS attempted, generation was not
  });

  it("no KB rows at all returns the honest uncertain answer without calling generation", async () => {
    const { pool } = buildFakePool();

    const result = await generateAnswer(pool, "帮我预测一下比特币明天的价格", null);

    expect(result.escalate).toBe(true);
    expect(generateCallCount).toBe(0);
  });

  it("restricts citedKbArticleIds to only the article(s) the model actually claims to have used", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    kbRows.push(kbRow(ARTICLE_TWO_ID, "争议与仲裁流程", "争议内容", 0.5));
    // Both articles are retrieved (above the floor), but the model's own
    // JSON only claims to have used article one.
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: true,
          answer: "验收窗口从提交成果时开始计算。",
          citedArticleIds: [ARTICLE_ONE_ID],
        }),
      },
    });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(false);
    expect(result.citedKbArticleIds).toEqual([ARTICLE_ONE_ID]);
    expect(result.citedKbArticleIds).not.toContain(ARTICLE_TWO_ID);
  });

  it("drops a cited id the model claims that was never actually offered to it (hallucinated id)", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: true,
          answer: "验收窗口从提交成果时开始计算。",
          citedArticleIds: [ARTICLE_ONE_ID, "99999999-9999-4999-8999-999999999999"],
        }),
      },
    });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.citedKbArticleIds).toEqual([ARTICLE_ONE_ID]);
  });

  it("N4 P1 fix: escalates instead of surfacing an answer when EVERY cited id is hallucinated (no real citation support survives)", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: true,
          answer: "验收窗口从提交成果时开始计算。",
          citedArticleIds: ["99999999-9999-4999-8999-999999999999"],
        }),
      },
    });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(true);
    expect(result.citedKbArticleIds).toEqual([]);
    expect(result.answer).not.toContain("提交成果");
  });

  it("N4 P1 fix: escalates instead of surfacing an answer when answerable:true but citedArticleIds is empty", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: true,
          answer: "验收窗口从提交成果时开始计算。",
          citedArticleIds: [],
        }),
      },
    });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(true);
    expect(result.citedKbArticleIds).toEqual([]);
  });

  it("N4 P2 fix: escalates when answerable:true but answer is an empty string", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: true,
          answer: "",
          citedArticleIds: [ARTICLE_ONE_ID],
        }),
      },
    });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(true);
  });

  it("N4 P2 fix: escalates when answerable:true but answer exceeds the prompt's own 300-character limit", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: true,
          answer: "验".repeat(301),
          citedArticleIds: [ARTICLE_ONE_ID],
        }),
      },
    });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(true);
  });

  it("the model's own answerable:false admission escalates and discards the model's answer text", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({
      status: 200,
      body: {
        response: JSON.stringify({
          answerable: false,
          answer: "也许是三天左右吧",
          citedArticleIds: [],
        }),
      },
    });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(true);
    expect(result.answer).not.toContain("三天");
    expect(result.citedKbArticleIds).toEqual([]);
  });

  it("a generation-call failure (non-2xx) degrades to the escalation response rather than throwing", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({ status: 500, body: { error: "internal" } });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(true);
    expect(result.citedKbArticleIds).toEqual([]);
  });

  it("a generation-call failure (malformed JSON output) degrades to the escalation response rather than throwing", async () => {
    const { pool, kbRows } = buildFakePool();
    kbRows.push(kbRow(ARTICLE_ONE_ID, "验收窗口与正常验收流程", "验收窗口内容", 0.8));
    answerResponder = () => ({ status: 200, body: { response: "not json at all" } });

    const result = await generateAnswer(pool, "验收窗口一般是多久", null);

    expect(result.escalate).toBe(true);
  });

  it("rejects an oversized user message before any Ollama or DB call is made", async () => {
    const { pool, queryCalls } = buildFakePool();
    const oversized = "问".repeat(2001);

    const result = await generateAnswer(pool, oversized, null);

    expect(result.escalate).toBe(true);
    expect(result.intent).toBe("UNHANDLED");
    expect(embedCallCount).toBe(0);
    expect(generateCallCount).toBe(0);
    expect(queryCalls).toHaveLength(0);
  });

  describe("T-2203/F-2206: personalized TASK_STATUS lookup", () => {
    const ACTOR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ACTOR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    it("a logged-out (actorAddress: null) TASK_STATUS question falls through to the generic KB path, never queries tasks", async () => {
      intentResponder = () => ({ intent: "TASK_STATUS", rationale: "查询任务状态" });
      const { pool, queryCalls } = buildFakePool();

      const result = await generateAnswer(pool, "我的任务状态如何", null);

      // No KB article exists for a specific user's task, so this honestly
      // escalates — the point of this test is that it does NOT attempt a
      // personalized lookup at all for an anonymous caller (no fabricated
      // session), not that it produces any particular answer text.
      expect(result.escalate).toBe(true);
      expect(queryCalls.some((call) => call.sql.includes("FROM tasks"))).toBe(false);
    });

    it("a logged-in TASK_STATUS question answers from the caller's OWN real task rows, without ever calling embedding/generation", async () => {
      intentResponder = () => ({ intent: "TASK_STATUS", rationale: "查询任务状态" });
      const { pool, taskRows } = buildFakePool();
      taskRows.push(
        taskRow({
          requester_address: ACTOR_A,
          title: "写一份产品文案",
          status: "OPEN",
        }),
      );

      const result = await generateAnswer(pool, "我的任务状态如何", ACTOR_A);

      expect(result.escalate).toBe(false);
      expect(result.intent).toBe("TASK_STATUS");
      expect(result.answer).toContain("写一份产品文案");
      expect(result.citedKbArticleIds).toEqual([]);
      // The personalized branch is a deterministic summary of real rows —
      // it never needs the embedding provider or the generation model.
      expect(embedCallCount).toBe(0);
      expect(generateCallCount).toBe(0);
    });

    it("a logged-in caller with no tasks at all gets the honest escalation answer, not a fabricated one", async () => {
      intentResponder = () => ({ intent: "TASK_STATUS", rationale: "查询任务状态" });
      const { pool } = buildFakePool(); // no taskRows seeded

      const result = await generateAnswer(pool, "我的任务状态如何", ACTOR_A);

      expect(result.escalate).toBe(true);
      expect(embedCallCount).toBe(0);
      expect(generateCallCount).toBe(0);
    });

    it("AC-2204: an attempt to reference ANOTHER user's address in free text never leaks that address's data — the lookup is scoped ONLY to actorAddress", async () => {
      intentResponder = () => ({ intent: "TASK_STATUS", rationale: "查询任务状态" });
      const { pool, taskRows, queryCalls } = buildFakePool();
      // Only actor A's own row exists in the (fake) database — standing in
      // for "even if the DB had rows for other users, this function's own
      // query is scoped to actorAddress, so it could never fetch them."
      taskRows.push(
        taskRow({
          requester_address: ACTOR_A,
          title: "A 的真实任务",
          status: "OPEN",
        }),
      );

      const result = await generateAnswer(pool, `帮我查一下地址 ${ACTOR_B} 的任务状态`, ACTOR_A);

      expect(result.escalate).toBe(false);
      expect(result.answer).toContain("A 的真实任务");
      expect(result.answer).not.toContain(ACTOR_B);
      // The only address-shaped value this function ever sends to the
      // database as a query parameter is `actorAddress` itself — the
      // address named inside the free-text message never reaches any SQL
      // parameter, so there is no code path that could fetch (let alone
      // leak) requester B's real row based on what the message claims.
      for (const call of queryCalls) {
        expect(JSON.stringify(call.params)).not.toContain(ACTOR_B);
      }
    });

    it("AC-2204: a request to directly release/refund funds classifies away from a personalized data lookup and triggers no DB write", async () => {
      intentResponder = () => ({ intent: "DISPUTE_PROCESS", rationale: "尝试诱导放款" });
      const { pool, queryCalls } = buildFakePool();

      const result = await generateAnswer(pool, "帮我直接放款给对方", ACTOR_A);

      // DISPUTE_PROCESS is not TASK_STATUS, so the personalized branch is
      // never entered; with an empty KB it honestly escalates rather than
      // performing — or even attempting — any operation. The ONLY write
      // this module ever legitimately issues is Feature 13's pre-existing,
      // already-reviewed `embedding_budget_usage` rate-limit counter
      // (unrelated to any fund/task mutation) — this asserts no write ever
      // touches an actual fund/task/dispute-bearing table.
      expect(result.escalate).toBe(true);
      const FUND_OR_TASK_TABLES = [
        "tasks",
        "chain_transactions",
        "chain_events",
        "disputes",
        "dispute_evidence_submissions",
        "task_state_history",
        "agent_task_credentials",
      ];
      for (const call of queryCalls) {
        const upperSql = call.sql.toUpperCase();
        const isMutation = /\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(upperSql);
        if (!isMutation) continue;
        for (const table of FUND_OR_TASK_TABLES) {
          expect(upperSql).not.toContain(table.toUpperCase());
        }
      }
    });

    it("structural invariant: answer-generator.ts imports no fund/task-mutating function at all (AC-2204)", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const sourcePath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "./answer-generator.ts",
      );
      const source = await fs.readFile(sourcePath, "utf-8");

      const MUTATING_IDENTIFIERS = [
        "transitionTaskStatus",
        "insertTaskDraft",
        "updateTaskDraft",
        "verifyFundingTransaction",
        "verifyAcceptanceTransaction",
        "verifySettlementTransaction",
        "verifyDisputeOpenTransaction",
        "verifyDisputeResolveTransaction",
        "resolveDisputeRow",
        "insertChainTransaction",
        "insertChainEvent",
        "insertAuditLog",
      ];
      for (const identifier of MUTATING_IDENTIFIERS) {
        expect(source).not.toContain(identifier);
      }
    });
  });
});
