import { z } from "zod";
import type { CandidateSnapshot } from "./repository.js";

/**
 * `POST /match`'s request wire format — field names match `matchRequest`
 * (services/dispatch/internal/httpapi/match.go, T-704) exactly.
 */
export interface MatchRequest {
  taskId: string;
  category: string;
  skillTags: string[];
  /** RFC3339. */
  deliveryDeadline: string;
  requiredLevel: string;
  requesterAddress: string;
  algorithmVersion: string;
  candidates: CandidateSnapshot[];
}

/** One recommended slot, matching `matchRecommendation` (Go). */
export interface MatchRecommendation {
  agentId: string;
  rank: number;
  slotType: string;
  score: number;
  reasons: string[];
}

/** `POST /match`'s response wire format, matching `matchResponse` (Go). */
export interface MatchResponse {
  taskId: string;
  algorithmVersion: string;
  recommendations: MatchRecommendation[];
}

/**
 * Runtime validation for `POST /match`'s response body (Codex review, T-705
 * round 1, P2: the Go dispatch service is a trust boundary — an unchecked
 * `as MatchResponse` type assertion would let a malformed response reach
 * `insertRecommendationRun`, potentially persisting garbage or throwing an
 * opaque database error deep inside a different function than the one that
 * actually received bad input). Field names/shape mirror `matchResponse`
 * (services/dispatch/internal/httpapi/match.go) exactly — this is the one
 * place that shape is enforced at runtime, not just assumed by the
 * `MatchResponse` TypeScript type above.
 */
// Tightened past plain z.string()/z.number() (Codex review, T-705 round 2,
// P2): a schema that accepts any string/any number lets a malformed-but-
// schema-shaped response (e.g. agentId: "x", rank: 1.5, an unknown
// slotType) pass validation here and only fail later at
// recommendation_candidates' UUID/INTEGER/CHECK constraints — turning a
// trust-boundary problem into an unhandled 500 instead of this module's
// documented 502. agentId is agents.id (a UUID); rank is a positive
// integer (Go's Slot.Rank is 1-based); slotType is the closed
// TOP_SCORE|EXPLORATION set (services/dispatch/internal/slotting.SlotType);
// score is bounded to [0,1] since every sub-score/weight in T-702's formula
// is itself in [0,1] and the weights sum to 1 — a value outside that range
// cannot be a legitimate output of that formula.
const matchRecommendationSchema = z.object({
  agentId: z.string().uuid(),
  rank: z.number().int().positive(),
  slotType: z.enum(["TOP_SCORE", "EXPLORATION"]),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});

const matchResponseSchema = z.object({
  taskId: z.string(),
  algorithmVersion: z.string(),
  recommendations: z.array(matchRecommendationSchema),
});

/** Bounded wait for the Go dispatch service's response — without this, a
 * connection the service accepts but never completes leaves the calling
 * API request pending indefinitely, holding its Fastify/database resources
 * open (Codex review, T-705 round 1, P1). 10s comfortably exceeds T-704's
 * measured ~2ms/1000-candidate P95, leaving headroom for a slow but still
 * legitimate response without masking a genuinely hung service. */
const DISPATCH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Thrown when the Go dispatch service can't be reached at all (network
 * error / connection refused) or responds with a non-2xx status —
 * routes.ts catches this and returns 502. Deliberately NOT one of
 * `@agent-market/domain`'s `ErrorCode` values: that enum is the single
 * source of truth for on-chain-transaction-review failure modes (PRD §11.4)
 * — "the dispatch service is unreachable" is an unrelated failure mode with
 * no on-chain-review meaning, so it gets its own error type instead of
 * overloading that enum with a second, disconnected concern (T-705 capsule).
 */
export class DispatchServiceUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DispatchServiceUnavailableError";
  }
}

/** Default matches `.env.example`'s `DISPATCH_PORT=8081` — read at call
 * time (not memoized), matching this codebase's established pattern for
 * env-derived config (tasks/service.ts's `resolveYdTokenAddress`) so tests
 * can set the env var right before calling `callMatch` without a
 * module-reload trick. */
function resolveDispatchServiceUrl(): string {
  return process.env.DISPATCH_SERVICE_URL ?? "http://127.0.0.1:8081";
}

/**
 * T-705: calls the Go dispatch service's `POST /match` with a plain `fetch`
 * — no HTTP client library is introduced, matching apps/api's existing
 * dependency footprint (this is the only outbound HTTP call in the module).
 * Any failure to get a successful (2xx) JSON response — network error,
 * non-2xx status — becomes a `DispatchServiceUnavailableError`; the caller
 * (routes.ts) is the only place that decides what HTTP status that maps to.
 */
export async function callMatch(
  request: MatchRequest,
  options: { traceId?: string } = {},
): Promise<MatchResponse> {
  const url = `${resolveDispatchServiceUrl()}/match`;

  // F-1919 (Feature 19, T-1912): forwards the SAME trace id `matchTask`
  // generates for this whole call chain, so Go's own log line
  // (`handleMatch`'s doc comment, services/dispatch) and this call's
  // eventual `dispatch_rerank_runs.trace_id` correlate to one real
  // request — Go never calls Python and stays unaware this header exists
  // for anything beyond logging it (F-1914/F-1915's three-party boundary
  // is unchanged).
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.traceId) {
    headers["X-Trace-Id"] = options.traceId;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(DISPATCH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // AbortSignal.timeout() firing surfaces here as a DOMException named
    // "TimeoutError" (or an AbortError, depending on runtime) — both are
    // "the service didn't respond", the same failure mode as a network
    // error, so both collapse into the same DispatchServiceUnavailableError
    // rather than needing a separate branch.
    throw new DispatchServiceUnavailableError(`dispatch service unreachable at ${url}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    // The upstream response BODY is never put into this error's `message`
    // (Codex review, T-705 round 2, P2): routes.ts forwards
    // DispatchServiceUnavailableError#message verbatim into its public 502
    // response, so an internal error/stack trace/other sensitive content
    // from the dispatch service's own error body would otherwise leak to
    // an authenticated-but-unrelated requester. The body is still captured
    // in `cause` for server-side logging (Fastify's error logger reads
    // Error#cause), just never in the client-facing message.
    const bodyText = await response.text().catch(() => "");
    throw new DispatchServiceUnavailableError(`dispatch service responded with a non-2xx status`, {
      cause: `status=${response.status} ${response.statusText} body=${bodyText}`,
    });
  }

  // A 2xx response is still an untrusted trust-boundary payload: parse and
  // validate it explicitly rather than asserting its shape. Both a JSON
  // parse failure and a schema mismatch are the same practical outcome as
  // any other dispatch-service failure — the caller can't use this
  // response — so both map to DispatchServiceUnavailableError, not an
  // uncaught exception that would surface as a 500 instead of routes.ts's
  // documented 502 (Codex review, T-705 round 1, P2).
  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (error) {
    throw new DispatchServiceUnavailableError(
      `dispatch service returned a 2xx response with invalid JSON`,
      { cause: error },
    );
  }

  const parsed = matchResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    // Same "no upstream content in the client-facing message" reasoning as
    // the non-2xx branch above — a Zod issue message can echo back
    // fragments of the offending value, so it stays in `cause` for logging
    // only, never in the message routes.ts forwards to the client.
    throw new DispatchServiceUnavailableError(
      `dispatch service returned a response that doesn't match the expected shape`,
      { cause: parsed.error },
    );
  }

  return parsed.data;
}
