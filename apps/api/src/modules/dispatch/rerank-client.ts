import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { components } from "./rerank-types.generated.js";

/**
 * F-1918 (T-1912): a thin, real HTTP wrapper around `services/dispatch-
 * rerank`'s `POST /rerank` — types come from the GENERATED contract
 * (`rerank-types.generated.d.ts`, `pnpm generate-rerank-types`, design.md
 * 决策 4), never hand-copied field names. This is the "生成客户端的薄封装"
 * tasks.md's own wording names: the generated file supplies TYPES only
 * (`openapi-typescript` doesn't emit a runtime client), so this module is
 * the one real caller that turns those types into an actual `fetch`.
 */
export type RerankRequestBody = components["schemas"]["RerankRequest"];
export type RerankResponseBody = components["schemas"]["RerankResponse"];
export type RerankStage = RerankRequestBody["stage"];

/**
 * N4 real finding (P2, round 1): a generated TYPE is a compile-time
 * assertion, not a runtime guarantee — `services/dispatch-rerank` is a
 * real trust boundary (a separate process, separate language, its own
 * deploy lifecycle), matching the same reasoning `dispatch.client.ts`'s
 * own `matchResponseSchema` already established for Go's response. An
 * unchecked `as RerankResponseBody` cast would let a service-version-
 * drifted or malformed 200 body (missing field, wrong type, a non-UUID
 * `rankingPolicyVersion` — that field is inserted straight into
 * `dispatch_rerank_runs.ranking_policy_version`, a real `UUID` FK column)
 * silently record a wrong `SUCCESS`/`DEGRADED` outcome, or crash the
 * INSERT itself and silently drop the whole observability row. Validated
 * here, at the trust boundary, before any caller ever sees the value —
 * a validation failure is treated exactly like any other malformed
 * response (mapped to `ERROR`, never thrown).
 */
const rerankResponseSchema = z.object({
  rankedAgentIds: z.array(z.string()),
  rationales: z.array(z.object({ agentId: z.string(), reason: z.string() })),
  rerankServiceVersion: z.string(),
  rankingPolicyVersion: z.string().uuid().nullable().optional(),
  llmAdopted: z.boolean(),
});

export type RerankCallOutcome = "SUCCESS" | "TIMEOUT" | "ERROR";

export interface RerankCallResult {
  outcome: RerankCallOutcome;
  response: RerankResponseBody | null;
  /** Total wall-clock time across every attempt (including retries) —
   * this is the number F-1919's `dispatch_rerank_runs.latency_ms` records,
   * since that column represents "how long did this ONE logical rerank
   * attempt take from Node's perspective," not any single HTTP round trip. */
  latencyMs: number;
  /** F-1919: the one value that lets this call's log lines be correlated
   * with Python's own (and, transitively, Go's — carried unchanged
   * through the whole chain, T-1912's own scope only generates and
   * records it on the Node↔Python leg). Stable across every retry
   * attempt within this one logical call. */
  traceId: string;
  errorMessage?: string;
}

export interface RerankClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** F-1919: reuse the trace id `matchTask` generated for the whole call
   * chain instead of minting a new one for this leg. */
  traceId?: string;
}

function resolveBaseUrl(options: RerankClientOptions): string {
  return options.baseUrl ?? process.env.DISPATCH_RERANK_URL ?? "http://localhost:8001";
}

/**
 * F-1918's own timeout requirement. Default is deliberately generous
 * (45s, not the low-hundreds-of-ms typical for a synchronous HTTP call):
 * `shadow-rerank.integration.test.ts`'s own real, measured end-to-end call
 * against a real local `qwen3:8b` took ~30s for 1-2 candidates (a
 * genuinely slow local "thinking" model call, not a bug) — this is a
 * real, known limitation of running inference synchronously inside
 * `matchTask`'s own request/response cycle, not something this Task can
 * or should paper over. F-1910's later latency/stability gates (T-1907)
 * are the actual mechanism that uses THIS real recorded latency to decide
 * whether reranking is even fit to leave SHADOW — that decision does not
 * belong in this client.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.DISPATCH_RERANK_TIMEOUT_MS ?? 45_000);
/**
 * N4-anticipated design note, confirmed by the same real measurement
 * above: a TIMEOUT is deliberately NOT retried (see the loop below) — a
 * slow-but-alive local LLM call is not the "transient blip" F-1918's own
 * retry requirement is aimed at, and retrying it would only double an
 * already-long wait for no real chance of a faster result. `maxRetries`
 * only ever applies to network errors and 5xx responses.
 */
const DEFAULT_MAX_RETRIES = Number(process.env.DISPATCH_RERANK_MAX_RETRIES ?? 1);

/**
 * F-1918's "区分可重试的瞬时错误与不可重试的业务错误": a network failure,
 * a client-side timeout, or a Python-side 5xx (the service itself is
 * unhealthy) are transient — worth one limited retry. A 4xx (this
 * service's own `RerankRequest` was malformed — always a real bug in the
 * CALLER, T-1912's own request-construction code, not a transient
 * condition) is never retried; retrying it would just reproduce the exact
 * same failure `maxRetries` times for no benefit.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

type AttemptResult =
  | { status: number; response: RerankResponseBody }
  | { status: number; invalidBody: string }
  | { timedOut: true }
  | { networkError: string };

async function attemptOnce(
  url: string,
  body: RerankRequestBody,
  traceId: string,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const httpResponse = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace-id": traceId },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawBody: unknown = await httpResponse.json();
    if (httpResponse.status === 200) {
      const parsed = rerankResponseSchema.safeParse(rawBody);
      if (!parsed.success) {
        // A Zod issue can echo fragments of the offending value — kept out
        // of the caller-facing message, same "don't leak upstream content"
        // discipline `dispatch.client.ts` already established.
        return { status: httpResponse.status, invalidBody: parsed.error.message };
      }
      return { status: httpResponse.status, response: parsed.data };
    }
    return { status: httpResponse.status, invalidBody: "non-200 status" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { timedOut: true };
    }
    return { networkError: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * F-1918's own idempotency requirement: exactly ONE `traceId` is generated
 * per logical call and reused across every retry attempt — a caller that
 * records `dispatch_rerank_runs` off this function's return value gets
 * exactly one row per logical rerank attempt, regardless of how many real
 * HTTP round trips it took underneath, and never has to reconcile
 * multiple, possibly-inconsistent attempt records for the same request.
 */
export async function callRerankService(
  request: RerankRequestBody,
  options: RerankClientOptions = {},
): Promise<RerankCallResult> {
  const url = `${resolveBaseUrl(options)}/rerank`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  // F-1919: reuses the SAME trace id `matchTask` generated for the whole
  // call chain (passed by `shadow-rerank.ts`) when given one, so this
  // call's `dispatch_rerank_runs.trace_id` matches the id Go's own log
  // line for the SAME `/match` request carries. Falls back to generating
  // one here for a direct/standalone caller (e.g. this module's own
  // integration tests) that has no larger chain to correlate with.
  const traceId = options.traceId ?? randomUUID();

  const startedAt = Date.now();
  let lastOutcome: RerankCallOutcome = "ERROR";
  let lastErrorMessage: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await attemptOnce(url, request, traceId, timeoutMs);

    if ("response" in result) {
      return {
        outcome: "SUCCESS",
        response: result.response,
        latencyMs: Date.now() - startedAt,
        traceId,
      };
    }

    if ("invalidBody" in result) {
      lastOutcome = "ERROR";
      lastErrorMessage = `dispatch-rerank returned HTTP ${result.status}: ${result.invalidBody}`;
      if (!isRetryableStatus(result.status)) {
        break;
      }
      continue;
    }

    if ("timedOut" in result) {
      lastOutcome = "TIMEOUT";
      lastErrorMessage = `dispatch-rerank call timed out after ${timeoutMs}ms`;
      // A timeout is a SLOW call, not a dropped connection — retrying it
      // would just double an already-long wait for no real chance of a
      // faster result (see DEFAULT_MAX_RETRIES's own doc comment above).
      break;
    }

    lastOutcome = "ERROR";
    lastErrorMessage = result.networkError;
  }

  return {
    outcome: lastOutcome,
    response: null,
    latencyMs: Date.now() - startedAt,
    traceId,
    errorMessage: lastErrorMessage,
  };
}
