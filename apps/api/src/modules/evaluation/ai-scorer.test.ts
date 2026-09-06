import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiScorerError, generateAiScoreSuggestion } from "./ai-scorer.js";

/**
 * F-2003/T-2003: a real local HTTP server standing in for Ollama's
 * `/api/generate` — same technique `backfill-embeddings.integration.test.ts`
 * (Feature 13) already established for a fake Ollama server, proving the
 * real HTTP request/response protocol works end to end rather than mocking
 * `fetch` itself.
 */
describe("generateAiScoreSuggestion (F-2003/T-2003)", () => {
  let server: Server;
  let baseUrl: string;
  let responder: (body: unknown) => { status: number; body: unknown };

  beforeEach(async () => {
    responder = () => ({
      status: 200,
      body: { response: JSON.stringify({ score: 80, rationale: "有理有据" }) },
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
    const result = await generateAiScoreSuggestion("解释幂等性", "幂等性指多次执行结果相同");
    expect(result).toEqual({ score: 80, rationale: "有理有据" });
  });

  it("sends the task prompt and submitted content in the request body", async () => {
    let capturedPrompt = "";
    responder = (body) => {
      capturedPrompt = (body as { prompt: string }).prompt;
      return { status: 200, body: { response: JSON.stringify({ score: 50, rationale: "x" }) } };
    };
    await generateAiScoreSuggestion("题目内容ABC", "提交内容XYZ");
    expect(capturedPrompt).toContain("题目内容ABC");
    expect(capturedPrompt).toContain("提交内容XYZ");
  });

  it("coerces a string score to a number", async () => {
    responder = () => ({
      status: 200,
      body: { response: JSON.stringify({ score: "75", rationale: "x" }) },
    });
    const result = await generateAiScoreSuggestion("p", "c");
    expect(result.score).toBe(75);
  });

  it("throws AiScorerError on a non-2xx response", async () => {
    responder = () => ({ status: 500, body: { error: "internal" } });
    await expect(generateAiScoreSuggestion("p", "c")).rejects.toBeInstanceOf(AiScorerError);
  });

  it("throws AiScorerError when the outer response body isn't the expected envelope", async () => {
    responder = () => ({ status: 200, body: { unexpected: true } });
    await expect(generateAiScoreSuggestion("p", "c")).rejects.toBeInstanceOf(AiScorerError);
  });

  it("throws AiScorerError when the model's own JSON output isn't valid JSON", async () => {
    responder = () => ({ status: 200, body: { response: "not json at all" } });
    await expect(generateAiScoreSuggestion("p", "c")).rejects.toBeInstanceOf(AiScorerError);
  });

  it("throws AiScorerError when the model's JSON output is missing required fields", async () => {
    responder = () => ({ status: 200, body: { response: JSON.stringify({ score: 80 }) } });
    await expect(generateAiScoreSuggestion("p", "c")).rejects.toBeInstanceOf(AiScorerError);
  });

  it("throws AiScorerError when the model's score is out of the 0-100 range", async () => {
    responder = () => ({
      status: 200,
      body: { response: JSON.stringify({ score: 150, rationale: "x" }) },
    });
    await expect(generateAiScoreSuggestion("p", "c")).rejects.toBeInstanceOf(AiScorerError);
  });

  it("throws AiScorerError when the Ollama server is unreachable", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(generateAiScoreSuggestion("p", "c")).rejects.toBeInstanceOf(AiScorerError);
    // Re-open so afterEach's own close() doesn't throw on an already-closed server.
    server = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
});
