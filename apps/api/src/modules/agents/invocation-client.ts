// Feature 12 (agent-task-fields-credentials), T-1203.
//
// See design.md's "范围边界": this client is an independent, self-verifying
// capability — NOT wired into any real business flow (no automated
// dispatch-and-execute). It exists so the HTTPS/Bearer/timeout/idempotency
// protocol contract (F-1204) is real, tested code, reachable today only via
// the diagnostic endpoint below.
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";
import { resolveCredential, CredentialResolutionError } from "./credential.js";

/** F-1204: total request timeout (including reading the full response
 * body). Plain `fetch`/`AbortSignal` does not expose a distinct
 * connect-phase timeout separate from the overall request without a
 * lower-level HTTP client (Node's `http.request` + socket timeouts) — this
 * project's established external-call convention (dispatch.client.ts)
 * deliberately stays on plain `fetch`, matching apps/api's existing
 * dependency footprint. The 5-second connect figure from F-1204 is
 * therefore treated as guidance for how quickly a well-behaved Agent
 * SHOULD respond, not a separately-enforced technical timeout in this V0
 * implementation — the 30-second total bound below is the actual
 * safety property (nothing can hang past it, regardless of which phase is
 * slow).
 *
 * Codex review (T-1203 round 2, Finding 3, P2): re-flagged the same gap —
 * a peer that accepts the TCP connection but never sends any response can
 * still occupy this diagnostic call for up to the full 30 seconds, not 5.
 * Reaffirmed rather than fixed: the accepted risk is bounded (a single
 * owner-triggered diagnostic call on their own Agent stalling for at most
 * 30s, not an unbounded hang, and not reachable by any other user's
 * request), the fix requires replacing `fetch` with `http.request` + manual
 * socket-timeout wiring in this one module, and design.md's own scope
 * boundary keeps this client out of any real dispatch/execution path in
 * this stage. If a later Feature wires this client into an automated,
 * unattended flow (design.md's "范围边界" no longer holds), this tradeoff
 * must be revisited then — an unattended caller can't rely on a human
 * noticing a stalled diagnostic call the way this endpoint's own owner can.
 */
const TOTAL_TIMEOUT_MS = 30_000;

/**
 * Codex review (T-1203 round 1, P1×2 — SSRF and plaintext-credential
 * transmission): before this function existed, any authenticated Agent
 * owner could point `invocationUrl` at `http://169.254.169.254/...` (a
 * cloud metadata endpoint), `http://localhost:5432` (this API's own
 * database port), or any other address reachable from the API server's own
 * network position — turning the diagnostic endpoint into a server-side
 * request forgery primitive — and, separately, an `http://` URL would send
 * the real resolved Bearer credential over plaintext.
 *
 * Both are closed here, before any credential is resolved or any request
 * is sent:
 * - protocol must be `https:` (F-1204 already specified HTTPS-only; this
 *   is where that requirement is actually enforced, not just documented —
 *   `agents/schema.ts`'s INVOCATION_URL_SCHEMA, Feature 5, still accepts
 *   `http://` for the field's original display-only purpose and is
 *   deliberately left alone; enforcement belongs at the one place that
 *   actually makes a network call with a real credential attached);
 * - every IP address the hostname resolves to (a hostname can resolve to
 *   more than one) is checked against private/loopback/link-local/
 *   reserved ranges — not just the literal hostname string, so
 *   `http://2130706433/` (127.0.0.1 as a decimal integer) or a DNS name an
 *   attacker points at an internal IP are caught the same way a literal
 *   `http://127.0.0.1/` would be.
 *
 * Known, accepted residual risk (not solved here, given this endpoint's
 * diagnostic-only scope and the two-day MVP time-box — design.md's "范围
 * 边界" already excludes this from any real business flow): DNS rebinding
 * (the name resolving safely at this check, then resolving to an internal
 * address by the time `fetch` itself connects) is not defended against —
 * closing it fully requires pinning the actual TCP connection to the
 * specific IP validated here (Node's `http.request` with a custom `lookup`
 * or `agent`, not plain `fetch`), which is a materially larger change than
 * this diagnostic capability's stated scope justifies. `redirect: "error"`
 * (set at the `fetch` call site) prevents an initially-safe destination
 * from redirecting to an internal one after this check has already passed.
 */
export async function assertSafeInvocationDestination(
  rawUrl: string,
): Promise<InvocationResult | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "network_error", message: "调用地址不是合法的 URL。" };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: "network_error",
      message: "调用地址必须是 https://，不支持明文 http://（避免凭据以明文传输）。",
    };
  }

  let addresses: string[];
  try {
    const results = await lookup(url.hostname, { all: true, verbatim: true });
    addresses = results.map((result) => result.address);
  } catch {
    return { ok: false, reason: "network_error", message: "无法解析调用地址的域名。" };
  }
  if (addresses.length === 0 || addresses.some((address) => isPrivateOrReservedAddress(address))) {
    return {
      ok: false,
      reason: "network_error",
      message: "调用地址解析到内网/回环/链路本地地址，已拒绝（防止 SSRF）。",
    };
  }
  return null;
}

/** IPv4 dotted-quad → 32-bit unsigned integer, for range comparison. */
function ipv4ToInt(address: string): number {
  return (
    address.split(".").reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0
  );
}

function inIpv4Range(address: string, base: string, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

function isPrivateOrReservedIpv4(address: string): boolean {
  return (
    inIpv4Range(address, "127.0.0.0", 8) ||
    inIpv4Range(address, "10.0.0.0", 8) ||
    inIpv4Range(address, "172.16.0.0", 12) ||
    inIpv4Range(address, "192.168.0.0", 16) ||
    inIpv4Range(address, "169.254.0.0", 16) ||
    inIpv4Range(address, "100.64.0.0", 10) ||
    inIpv4Range(address, "0.0.0.0", 8) ||
    inIpv4Range(address, "224.0.0.0", 4)
  );
}

/**
 * Parses any valid IPv6 text form — including `::` compression and an
 * embedded IPv4 dotted-decimal suffix (`::ffff:127.0.0.1`) — into its 8
 * 16-bit groups. `null` for anything malformed.
 *
 * Codex review (T-1203 round 2, P1): the previous version matched IPv6
 * ranges with plain string prefixes (`startsWith("fe80:")`), which misses
 * both the hex form of an IPv4-mapped address (`::ffff:7f00:1`, the same
 * 127.0.0.1 as `::ffff:127.0.0.1` but never matched by a dotted-decimal-only
 * regex) and most of the real fe80::/10 range (`fe90::1` etc. — a /10
 * prefix is NOT the same as the 4-character literal string "fe80:").
 * Expanding to actual 16-bit groups and doing real bitmask comparisons
 * (matching how `inIpv4Range` already works for IPv4) is the only way to
 * check a CIDR range correctly rather than a string that merely looks
 * similar to one.
 */
function parseIpv6Groups(address: string): number[] | null {
  const ipv4Suffix = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  let base = address;
  if (ipv4Suffix) {
    const [, prefix, ipv4] = ipv4Suffix;
    const octets = (ipv4 ?? "").split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    base = `${prefix}${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }

  const halves = base.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string | undefined) =>
    side ? side.split(":").filter((group) => group.length > 0) : [];
  const head = parseSide(halves[0]);
  const tail = halves.length === 2 ? parseSide(halves[1]) : [];

  let groupStrings: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groupStrings = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groupStrings = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  if (groupStrings.length !== 8) return null;

  const groups = groupStrings.map((group) => Number.parseInt(group, 16));
  if (groups.some((value) => Number.isNaN(value) || value < 0 || value > 0xffff)) return null;
  return groups;
}

/** Blocks loopback, RFC1918 private, link-local (incl. the 169.254.169.254
 * cloud metadata endpoint), CGNAT, and multicast/reserved ranges for IPv4;
 * loopback, unspecified, unique-local (fc00::/7), and link-local
 * (fe80::/10) for IPv6, plus an IPv4-mapped IPv6 address's embedded IPv4
 * range (in either its hex or dotted-decimal text form). */
export function isPrivateOrReservedAddress(address: string): boolean {
  if (isIPv4(address)) {
    return isPrivateOrReservedIpv4(address);
  }

  const groups = parseIpv6Groups(address.toLowerCase());
  if (!groups) return false; // Not a recognizable IPv6 address either — fail open is wrong here, but assertSafeInvocationDestination's caller already treats an unparseable lookup result as unsafe via the "no addresses" branch; this function's job is only real range checks.
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const isUnspecifiedOrLoopback =
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    (g7 === 0 || g7 === 1);
  const isLinkLocal = (g0 & 0xffc0) === 0xfe80; // fe80::/10
  const isUniqueLocal = (g0 & 0xfe00) === 0xfc00; // fc00::/7
  const isIpv4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;

  if (isIpv4Mapped) {
    const embeddedIpv4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isPrivateOrReservedIpv4(embeddedIpv4);
  }
  return isUnspecifiedOrLoopback || isLinkLocal || isUniqueLocal;
}

export type InvocationResult =
  | { ok: true; statusCode: number; body: unknown }
  | {
      ok: false;
      reason: "credential_unresolved" | "timeout" | "network_error" | "invalid_response";
      /** Safe-to-display Chinese explanation — never includes any upstream
       * response content or credential value (see the branches below). */
      message: string;
    };

/**
 * Calls an Agent's `invocationUrl` per F-1204's protocol (HTTPS JSON POST,
 * `Authorization: Bearer <resolved credential>`, a fresh `Idempotency-Key`
 * per call, 30s total timeout). Never throws for an expected failure mode
 * (credential unresolved, timeout, network error, non-JSON/malformed
 * response) — those all resolve to `{ ok: false, ... }` so a caller (the
 * diagnostic route) can report a clean result without a try/catch of its
 * own. Trusts nothing from the response body beyond "is it valid JSON" —
 * the actual body is returned as `unknown` for the caller to interpret,
 * this function has no opinion on an Agent's response schema.
 */
export async function callAgent(
  agent: { invocationUrl: string | null; credentialRef: string | null },
  payload: unknown,
  options: {
    /** Test seam only — production callers never pass this, always getting
     * the real `TOTAL_TIMEOUT_MS`. Exists because mixing a real socket
     * (a real HTTP server in invocation-client.test.ts) with vitest's fake
     * timers doesn't work — `AbortSignal.timeout` and real I/O both run on
     * the real clock regardless of a faked one, so the only way to test
     * the timeout path in real (not 30 simulated-but-actually-real)
     * seconds is to inject a short real timeout. */
    timeoutMs?: number;
    /** Test seam only — never passed by service.ts (the only production
     * caller). `assertSafeInvocationDestination` (Codex review, T-1203
     * round 1, P1 SSRF/plaintext-credential fixes) rejects any non-HTTPS
     * or loopback/private destination — which a real local HTTP test
     * server necessarily is (plain http, 127.0.0.1). This flag exists
     * solely so tests can exercise everything AFTER that check (credential
     * headers, idempotency key, JSON/timeout handling) against a real
     * local server; the check itself has its own direct tests (see
     * `assertSafeInvocationDestination`'s and `isPrivateOrReservedAddress`'s
     * own test suites) that never set this flag. */
    skipDestinationCheck?: boolean;
  } = {},
): Promise<InvocationResult> {
  if (!agent.invocationUrl) {
    return {
      ok: false,
      reason: "network_error",
      message: "该 Agent 尚未配置调用地址（invocationUrl）。",
    };
  }

  // Checked before credential resolution — an unsafe destination is
  // rejected without ever touching process.env, minimizing the window in
  // which a resolved credential value exists in memory at all.
  if (!options.skipDestinationCheck) {
    const unsafeDestination = await assertSafeInvocationDestination(agent.invocationUrl);
    if (unsafeDestination) {
      return unsafeDestination;
    }
  }

  let credential: string;
  try {
    credential = resolveCredential(agent.credentialRef);
  } catch (error) {
    if (error instanceof CredentialResolutionError) {
      return { ok: false, reason: "credential_unresolved", message: error.message };
    }
    throw error;
  }

  let response: Response;
  try {
    response = await fetch(agent.invocationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
        // A fresh key per call (F-1204/F-1208): this function only
        // generates and transmits it — whether the receiving Agent service
        // actually implements idempotent handling is entirely outside this
        // function's control or knowledge.
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? TOTAL_TIMEOUT_MS),
      // Never follow a redirect (Codex review, T-1203 round 1, P1 SSRF
      // finding: "account for redirects") — a destination that passed
      // assertSafeInvocationDestination above could still redirect
      // somewhere unsafe; refusing to follow at all is simpler and more
      // conservative than re-validating each hop, and this diagnostic
      // client has no legitimate need to follow one.
      redirect: "error",
    });
  } catch (error) {
    // AbortSignal.timeout() firing and a genuine network failure (DNS,
    // connection refused, TLS error) both surface as a rejected fetch —
    // same "timeout vs. network error" ambiguity dispatch.client.ts's own
    // doc comment notes. Distinguished here (unlike that module) because
    // the diagnostic endpoint's whole purpose is reporting which failure
    // mode actually occurred (AC-1203 requires proving the timeout path
    // specifically), not just "unreachable."
    const isTimeout =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const timeoutSeconds = (options.timeoutMs ?? TOTAL_TIMEOUT_MS) / 1000;
    return isTimeout
      ? { ok: false, reason: "timeout", message: `调用超时（超过 ${timeoutSeconds} 秒）。` }
      : { ok: false, reason: "network_error", message: "网络错误，无法连接到 Agent 调用地址。" };
  }

  // The response body is never echoed into a thrown/returned message on
  // any failure path below (same reasoning as dispatch.client.ts: an
  // Agent's own response — error page, stack trace, or anything else — is
  // untrusted content this module must not forward verbatim to whoever
  // triggered the diagnostic call).
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      reason: "invalid_response",
      message: "Agent 响应不是合法 JSON。",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "invalid_response",
      message: `Agent 返回了非成功状态码（${response.status}）。`,
    };
  }

  return { ok: true, statusCode: response.status, body };
}
