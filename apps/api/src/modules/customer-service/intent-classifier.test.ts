import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyIntent, IntentClassifierError } from "./intent-classifier.js";

/**
 * F-2201/T-2201: a real local HTTP server standing in for Ollama's
 * `/api/generate` — same technique `ai-scorer.test.ts` (F-2003/T-2003)
 * already established, proving the real HTTP request/response protocol
 * works end to end rather than mocking `fetch` itself. The
 * genuinely-real local Ollama chain (actual qwen3:8b inference) lives in
 * `intent-classifier.integration.test.ts`, gated behind
 * `RUN_OLLAMA_INTEGRATION_TESTS=1`.
 */
describe("classifyIntent (F-2201/T-2201)", () => {
  let server: Server;
  let baseUrl: string;
  let responder: (body: unknown) => { status: number; body: unknown };

  beforeEach(async () => {
    responder = () => ({
      status: 200,
      body: { response: JSON.stringify({ intent: "PLATFORM_USAGE", rationale: "操作类问题" }) },
    });
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const { status, body } = responder(raw ? JSON.parse(raw) : {});
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
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

  it("parses a real, well-formed Ollama /api/generate response", async () => {
    const result = await classifyIntent("怎么发布一个任务？");
    expect(result).toEqual({ intent: "PLATFORM_USAGE", rationale: "操作类问题" });
  });

  it("sends the user message in the request prompt", async () => {
    let capturedPrompt = "";
    responder = (body) => {
      capturedPrompt = (body as { prompt: string }).prompt;
      return {
        status: 200,
        body: { response: JSON.stringify({ intent: "TASK_STATUS" }) },
      };
    };
    await classifyIntent("我的任务为什么还没匹配到 Agent？");
    expect(capturedPrompt).toContain("我的任务为什么还没匹配到 Agent？");
  });

  it("accepts a response with no rationale field (optional)", async () => {
    responder = () => ({
      status: 200,
      body: { response: JSON.stringify({ intent: "DISPUTE_PROCESS" }) },
    });
    const result = await classifyIntent("对方交付的东西不合格我该怎么办？");
    expect(result.intent).toBe("DISPUTE_PROCESS");
  });

  it("throws IntentClassifierError on a non-2xx response", async () => {
    responder = () => ({ status: 500, body: { error: "internal" } });
    await expect(classifyIntent("p")).rejects.toBeInstanceOf(IntentClassifierError);
  });

  it("throws IntentClassifierError when the outer response body isn't the expected envelope", async () => {
    responder = () => ({ status: 200, body: { unexpected: true } });
    await expect(classifyIntent("p")).rejects.toBeInstanceOf(IntentClassifierError);
  });

  it("throws IntentClassifierError when the model's own JSON output isn't valid JSON", async () => {
    responder = () => ({ status: 200, body: { response: "not json at all" } });
    await expect(classifyIntent("p")).rejects.toBeInstanceOf(IntentClassifierError);
  });

  it("throws IntentClassifierError when the model returns an out-of-enum intent value (untrusted model output boundary)", async () => {
    // Real defensive-parsing test: the model is untrusted input, same trust
    // boundary ai-scorer.ts already applies to score/rationale. Simulating a
    // hallucinated category here (not a real model behavior we're testing)
    // proves the closed z.enum(INTENT_CATEGORIES) actually rejects it rather
    // than silently accepting/coercing an unknown category.
    responder = () => ({
      status: 200,
      body: { response: JSON.stringify({ intent: "REFUND_MY_MONEY_NOW", rationale: "x" }) },
    });
    await expect(classifyIntent("p")).rejects.toBeInstanceOf(IntentClassifierError);
  });

  it("rejects an oversized user message before making any Ollama request (N4 P2 fix)", async () => {
    let requestCount = 0;
    responder = () => {
      requestCount += 1;
      return { status: 200, body: { response: JSON.stringify({ intent: "PLATFORM_USAGE" }) } };
    };
    const oversized = "问".repeat(2001);
    await expect(classifyIntent(oversized)).rejects.toBeInstanceOf(IntentClassifierError);
    expect(requestCount).toBe(0);
  });

  it("throws IntentClassifierError when the Ollama server is unreachable", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(classifyIntent("p")).rejects.toBeInstanceOf(IntentClassifierError);
    // Re-open so afterEach's own close() doesn't throw on an already-closed server.
    server = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
});
