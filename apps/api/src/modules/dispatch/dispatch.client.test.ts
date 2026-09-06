import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateSnapshot } from "./repository.js";
import {
  callMatch,
  checkDispatchSupportsRiskHoldGate,
  DispatchServiceUnavailableError,
  resetRiskHoldGateCapabilityCacheForTests,
  type MatchRequest,
} from "./dispatch.client.js";

// T-705: unit tests for callMatch — mocks global fetch, no real Go service
// involved. Verifies the request body shape sent to POST /match, and that
// both a non-2xx response and a network error surface as
// DispatchServiceUnavailableError (routes.ts's only signal to return 502).
describe("callMatch (unit, T-705)", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.DISPATCH_SERVICE_URL;

  beforeEach(() => {
    process.env.DISPATCH_SERVICE_URL = "http://127.0.0.1:9999";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.DISPATCH_SERVICE_URL;
    } else {
      process.env.DISPATCH_SERVICE_URL = originalEnv;
    }
    vi.restoreAllMocks();
  });

  const CANDIDATE: CandidateSnapshot = {
    agentId: "11111111-1111-1111-1111-111111111111",
    walletAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    status: "ACTIVE",
    category: "writing",
    skillTags: ["copywriting"],
    level: "BEGINNER",
    maxConcurrentTasks: 3,
    activeTaskCount: 0,
    completedTaskCount: 0,
    successCount: 0,
    overdueCount: 0,
    qualityScore: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    isBanned: false,
    baselineEvaluationStatus: "PASSED",
    riskHoldStatus: "NONE",
  };

  const REQUEST: MatchRequest = {
    taskId: "22222222-2222-2222-2222-222222222222",
    category: "writing",
    skillTags: ["copywriting"],
    deliveryDeadline: "2030-01-01T00:00:00.000Z",
    requiredLevel: "BEGINNER",
    requesterAddress: "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4",
    algorithmVersion: "v0.1",
    candidates: [CANDIDATE],
    enforceBaselineEvaluationGate: false,
    enforceRiskHoldGate: false,
  };

  it("POSTs the exact request body to <DISPATCH_SERVICE_URL>/match and returns the parsed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          taskId: REQUEST.taskId,
          algorithmVersion: "v0.1",
          recommendations: [
            {
              agentId: CANDIDATE.agentId,
              rank: 1,
              slotType: "TOP_SCORE",
              score: 0.9,
              reasons: ["x"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await callMatch(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/match");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);

    expect(response.recommendations).toHaveLength(1);
    expect(response.recommendations[0]?.agentId).toBe(CANDIDATE.agentId);
  });

  it("throws DispatchServiceUnavailableError on a non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("internal error", { status: 500, statusText: "Internal Server Error" }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callMatch(REQUEST)).rejects.toThrow(DispatchServiceUnavailableError);
  });

  it("throws DispatchServiceUnavailableError on a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callMatch(REQUEST)).rejects.toThrow(DispatchServiceUnavailableError);
  });

  // Regression for Codex round 1 P1: a request with no deadline could hang
  // forever if the dispatch service accepts the connection but never
  // responds. Asserts the fix's actual mechanism (an AbortSignal is passed
  // to fetch), not just its symptom, so a future edit that silently removes
  // the timeout would fail this test even if nothing was slow enough to
  // observe in a fast unit test run.
  it("passes an AbortSignal to fetch so a hung dispatch service can't block forever", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ taskId: REQUEST.taskId, algorithmVersion: "v0.1", recommendations: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callMatch(REQUEST);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces an aborted/timed-out request as DispatchServiceUnavailableError", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callMatch(REQUEST)).rejects.toThrow(DispatchServiceUnavailableError);
  });

  // Regression for Codex round 1 P2: a 2xx response is still an untrusted
  // trust-boundary payload — malformed JSON or a schema mismatch must not
  // reach insertRecommendationRun (or surface as an uncaught exception
  // outside routes.ts's documented 502 path).
  it("throws DispatchServiceUnavailableError on a 2xx response with invalid JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{not valid json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callMatch(REQUEST)).rejects.toThrow(DispatchServiceUnavailableError);
  });

  it("throws DispatchServiceUnavailableError on a 2xx response that doesn't match the expected schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ totally: "wrong shape" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callMatch(REQUEST)).rejects.toThrow(DispatchServiceUnavailableError);
  });

  // Regression for Codex round 2 P2: agentId must be a real UUID, rank a
  // positive integer, slotType a known value, score within [0,1] — a
  // schema that accepts any string/number would only fail later at the
  // database's own constraints, turning a trust-boundary problem into an
  // unhandled 500 instead of this module's documented 502.
  it.each([
    ["non-UUID agentId", { agentId: "not-a-uuid" }],
    ["non-integer rank", { rank: 1.5 }],
    ["zero rank", { rank: 0 }],
    ["unknown slotType", { slotType: "MAYBE_SCORE" }],
    ["score above 1", { score: 1.5 }],
    ["negative score", { score: -0.1 }],
  ])("rejects a recommendation with %s", async (_label, overrides) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          taskId: REQUEST.taskId,
          algorithmVersion: "v0.1",
          recommendations: [
            {
              agentId: CANDIDATE.agentId,
              rank: 1,
              slotType: "TOP_SCORE",
              score: 0.9,
              reasons: ["x"],
              ...overrides,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callMatch(REQUEST)).rejects.toThrow(DispatchServiceUnavailableError);
  });

  // Regression for Codex round 2 P2: the dispatch service's own error body
  // (which could contain internal stack traces or other sensitive detail)
  // must never end up in the message routes.ts forwards to a public 502
  // response.
  it("does not include the upstream response body in the thrown error's message", async () => {
    const sensitiveDetail = "internal stack trace: secret-config-path leaked here";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(sensitiveDetail, { status: 500, statusText: "Boom" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callMatch(REQUEST)).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes(sensitiveDetail);
    });
  });
});

// F-2010/T-2008 (N4 round-2 real finding + user's 2026-09-06 follow-up
// decision): unit tests for checkDispatchSupportsRiskHoldGate — mocks
// global fetch, no real Go service involved. Verifies the capability
// probe's own "never assume supported" contract: only an explicit
// `capabilities` array containing "risk_hold_gate" returns true; every
// other outcome (missing key, wrong value, non-2xx, network error,
// malformed JSON, timeout) returns false.
describe("checkDispatchSupportsRiskHoldGate (unit, T-2008)", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.DISPATCH_SERVICE_URL;

  beforeEach(() => {
    process.env.DISPATCH_SERVICE_URL = "http://127.0.0.1:9999";
    resetRiskHoldGateCapabilityCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.DISPATCH_SERVICE_URL;
    } else {
      process.env.DISPATCH_SERVICE_URL = originalEnv;
    }
    resetRiskHoldGateCapabilityCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns true when /healthz advertises the risk_hold_gate capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", capabilities: ["risk_hold_gate"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/healthz");
    expect(init.method).toBe("GET");
  });

  it("returns false when /healthz omits capabilities entirely (older dispatch)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(false);
  });

  it("returns false when capabilities is present but doesn't include risk_hold_gate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", capabilities: ["something_else"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(false);
  });

  it("returns false on a non-2xx /healthz response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(false);
  });

  it("returns false on a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(false);
  });

  it("returns false on malformed JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{not valid json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(false);
  });

  it("caches a positive result — a second call within the TTL does not call fetch again", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", capabilities: ["risk_hold_gate"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(true);
    await expect(checkDispatchSupportsRiskHoldGate()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
