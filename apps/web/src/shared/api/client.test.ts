import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchOk(body: unknown = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCallInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit] | undefined;
  if (!call) throw new Error("fetch was never called");
  return call[1];
}

/**
 * Regression for a real bug found during T-505's manual browser walkthrough:
 * apiFetch unconditionally set Content-Type: application/json regardless of
 * whether a body was present. apps/api's Fastify JSON body parser rejects
 * an empty body under that content-type as a 400 — a bodyless POST
 * (activateAgent/deactivateAgent, /auth/logout) never reached the route
 * handler at all. These tests assert on the actual headers `fetch` was
 * called with, which is the level this bug lived at (mocking the
 * higher-level agents API module, as most other tests here do, would never
 * exercise this code path).
 */
describe("apiFetch — Content-Type header", () => {
  it("does not set Content-Type on a request with no body (T-505 P1 regression)", async () => {
    const fetchMock = stubFetchOk();
    await apiFetch("/agents/some-id/deactivate", { method: "POST" });

    const headers = new Headers(lastCallInit(fetchMock).headers);
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("sets Content-Type: application/json on a request with a JSON body", async () => {
    const fetchMock = stubFetchOk();
    await apiFetch("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });

    const headers = new Headers(lastCallInit(fetchMock).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("lets a caller-supplied Content-Type override the default", async () => {
    const fetchMock = stubFetchOk();
    await apiFetch("/agents", {
      method: "POST",
      body: "name=x",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const headers = new Headers(lastCallInit(fetchMock).headers);
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
  });

  it("still sends credentials: include and parses a JSON response for a bodyless request", async () => {
    const fetchMock = stubFetchOk({ ok: true });
    const result = await apiFetch<{ ok: boolean }>("/auth/logout", { method: "POST" });

    expect(lastCallInit(fetchMock).credentials).toBe("include");
    expect(result).toEqual({ ok: true });
  });

  it("throws ApiError with the server's message on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "请求失败（HTTP 400）" } }), {
            status: 400,
          }),
      ),
    );
    await expect(apiFetch("/agents/x/deactivate", { method: "POST" })).rejects.toThrow(ApiError);
  });
});
