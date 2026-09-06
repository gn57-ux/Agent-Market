import { describe, expect, it } from "vitest";
import { callRerankService, type RerankRequestBody } from "./rerank-client.js";

/**
 * Real HTTP integration test for T-1912's `callRerankService` against a
 * real, locally-running `services/dispatch-rerank` FastAPI process — same
 * "opt-in, needs a real external service" convention as
 * RUN_DB_INTEGRATION_TESTS/RUN_OLLAMA_INTEGRATION_TESTS. Skipped by
 * default (CI has no Python service running); run locally with:
 *   cd services/dispatch-rerank && uv run uvicorn app.main:app --port 8001
 *   RUN_DISPATCH_RERANK_INTEGRATION_TESTS=1 pnpm --filter @agent-market/api test -- rerank-client
 */
const runIfOptedIn =
  process.env.RUN_DISPATCH_RERANK_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const baseRequest: RerankRequestBody = {
  candidates: [
    { agentId: "agent-1", v0Score: 0.9 },
    { agentId: "agent-2", v0Score: 0.4 },
  ],
  taskDescription: "write a landing page",
  stage: "SHADOW",
};

runIfOptedIn("callRerankService (integration, T-1912, real dispatch-rerank)", () => {
  it(
    "returns SUCCESS with a real response body from the real service",
    async () => {
      // A real local qwen3:8b call measured tens of seconds in T-1911's own
      // testing — well past this client's own 15s default timeout, which
      // exists to protect a PRODUCTION `/match` request, not this test's
      // patience. Overridden here so this test verifies the real happy
      // path rather than incidentally testing the timeout path instead.
      const result = await callRerankService(baseRequest, { timeoutMs: 90_000 });
      expect(result.outcome).toBe("SUCCESS");
      expect(result.response).not.toBeNull();
      expect(sortedIds(result.response?.rankedAgentIds ?? [])).toEqual(["agent-1", "agent-2"]);
      expect(typeof result.response?.rerankServiceVersion).toBe("string");
      expect(result.response?.llmAdopted).toBeDefined();
      expect(result.traceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.latencyMs).toBeGreaterThan(0);
    },
    { timeout: 95_000 },
  );

  it("F-1918: returns ERROR (not a thrown exception) when the service is unreachable", async () => {
    const result = await callRerankService(baseRequest, {
      baseUrl: "http://localhost:1", // nothing listens here
      timeoutMs: 2000,
      maxRetries: 0,
    });
    expect(result.outcome).toBe("ERROR");
    expect(result.response).toBeNull();
    expect(result.errorMessage).toBeTruthy();
  });

  it("F-1918: returns TIMEOUT when the client-side timeout is shorter than the real call takes", async () => {
    const result = await callRerankService(baseRequest, {
      timeoutMs: 1, // the real service call always takes longer than 1ms
      maxRetries: 0,
    });
    expect(result.outcome).toBe("TIMEOUT");
    expect(result.response).toBeNull();
  });
});

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}
