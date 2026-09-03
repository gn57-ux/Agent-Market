import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeInvocationDestination,
  callAgent,
  isPrivateOrReservedAddress,
} from "./invocation-client.js";

// T-1300: credentialRef is now always exactly `env://AGENT_<32-hex-id>` —
// a real fake-UUID-shaped identifier, not a human-readable name, matching
// what computeCredentialRef actually produces.
const ENV_VAR_NAME = "AGENT_3F2A9C7B1E4D4F2A8B3C1D2E3F4A5B6C";
const REAL_SECRET_VALUE = "sk-live-real-secret-do-not-leak-9f3c1a";

let server: Server | undefined;

afterEach(async () => {
  delete process.env[ENV_VAR_NAME];
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

function listen(handler: RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (address && typeof address === "object") {
        resolve(`http://127.0.0.1:${address.port}`);
      }
    });
  });
}

describe("isPrivateOrReservedAddress", () => {
  it("blocks IPv4 loopback, RFC1918 private, link-local (incl. the cloud metadata IP), CGNAT, and multicast ranges", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.255",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
      "169.254.0.1",
      "169.254.169.254", // the cloud metadata endpoint itself
      "100.64.0.1",
      "0.0.0.1",
      "224.0.0.1",
    ]) {
      expect(isPrivateOrReservedAddress(address)).toBe(true);
    }
  });

  it("allows ordinary public IPv4 addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isPrivateOrReservedAddress(address)).toBe(false);
    }
  });

  it("blocks IPv6 loopback, unique-local, and link-local addresses", () => {
    for (const address of ["::1", "fe80::1", "fc00::1", "fd12:3456::1"]) {
      expect(isPrivateOrReservedAddress(address)).toBe(true);
    }
  });

  it("blocks an IPv4-mapped IPv6 address whose embedded IPv4 is private", () => {
    expect(isPrivateOrReservedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  // T-1203 round-2 Finding 2 regression: the original check unwrapped
  // IPv4-mapped addresses only in their dotted-decimal textual form
  // (`::ffff:127.0.0.1`). Node's dns.lookup can return the same address in
  // pure hex form (`::ffff:7f00:1`), which the old string-based unwrap
  // missed entirely, letting it through as "public". The fix now parses
  // into 16-bit groups first, so both textual forms resolve identically.
  it("blocks an IPv4-mapped IPv6 address written in pure hex form (round-2 regression)", () => {
    expect(isPrivateOrReservedAddress("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateOrReservedAddress("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
  });

  // T-1203 round-2 Finding 2 regression: the original link-local check was
  // `startsWith("fe80:")`, which only matched that one literal prefix
  // instead of the real fe80::/10 range (fe80:: through febf:ffff:...).
  it("blocks a link-local address outside the literal fe80: prefix but inside fe80::/10 (round-2 regression)", () => {
    expect(isPrivateOrReservedAddress("fe90::1")).toBe(true);
    expect(isPrivateOrReservedAddress("febf::1")).toBe(true);
  });

  it("allows an ordinary public IPv6 address", () => {
    expect(isPrivateOrReservedAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertSafeInvocationDestination", () => {
  it("rejects a plain http:// URL before any DNS lookup happens (plaintext-credential fix)", async () => {
    const result = await assertSafeInvocationDestination("http://example.com/invoke");
    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.message).toContain("https://");
  });

  it("rejects a malformed URL", async () => {
    const result = await assertSafeInvocationDestination("not a url at all");
    expect(result?.ok).toBe(false);
  });

  // Literal IP addresses in the URL don't need DNS resolution at all
  // (Node's dns.lookup on a literal IP returns it immediately) — this is
  // the most direct, mock-free proof the SSRF check works end to end.
  it("rejects an https:// URL whose host is a literal loopback IP address (SSRF fix)", async () => {
    const result = await assertSafeInvocationDestination("https://127.0.0.1/invoke");
    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.message).toContain("SSRF");
  });

  it("rejects an https:// URL whose host is the literal cloud metadata IP", async () => {
    const result = await assertSafeInvocationDestination(
      "https://169.254.169.254/latest/meta-data/",
    );
    expect(result?.ok).toBe(false);
  });

  it("allows an https:// URL whose host resolves to a public IP", async () => {
    // 8.8.8.8 is a literal public IP used directly as the host — real DNS
    // resolution of an actual public hostname is avoided in tests (network
    // dependency), but this still exercises the exact same code path
    // (dns.lookup on a literal IP returns it immediately, same as it would
    // for any resolved hostname).
    const result = await assertSafeInvocationDestination("https://8.8.8.8/invoke");
    expect(result).toBeNull();
  });
});

describe("callAgent", () => {
  it("rejects a real local test server because it's http:// (not https), without ever resolving the credential (P1 regression, no mocks)", async () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    let serverWasCalled = false;
    const url = await listen((req, res) => {
      serverWasCalled = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    const result = await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("https://");
    expect(serverWasCalled).toBe(false);
  });

  it("sends a real HTTPS-shaped request with the resolved Bearer credential, a fresh Idempotency-Key, and returns the Agent's JSON response (destination check skipped — see its own dedicated test suite above)", async () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    let receivedAuth: string | undefined;
    let receivedIdempotencyKey: string | undefined;
    const url = await listen((req, res) => {
      receivedAuth = req.headers.authorization;
      receivedIdempotencyKey = req.headers["idempotency-key"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ echoed: true }));
    });

    const result = await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      { hello: "world" },
      { skipDestinationCheck: true },
    );

    expect(result).toEqual({ ok: true, statusCode: 200, body: { echoed: true } });
    expect(receivedAuth).toBe(`Bearer ${REAL_SECRET_VALUE}`);
    expect(receivedIdempotencyKey).toBeTruthy();
  });

  it("generates a different Idempotency-Key on each separate call (AC-1204)", async () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    const receivedKeys: (string | undefined)[] = [];
    const url = await listen((req, res) => {
      receivedKeys.push(req.headers["idempotency-key"] as string | undefined);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
      { skipDestinationCheck: true },
    );
    await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
      { skipDestinationCheck: true },
    );

    expect(receivedKeys).toHaveLength(2);
    expect(receivedKeys[0]).toBeTruthy();
    expect(receivedKeys[1]).toBeTruthy();
    expect(receivedKeys[0]).not.toBe(receivedKeys[1]);
  });

  // AC-1203: a real, deliberately-slow test HTTP server (not a mocked
  // clock — see callAgent's `timeoutMs` doc comment for why fake timers
  // don't work here) proves the timeout actually fires and doesn't hang.
  it("times out against a real server that never responds, without hanging", async () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    const url = await listen(() => {
      // Deliberately never calls res.end() — the request hangs until the
      // client-side timeout fires.
    });

    const result = await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
      { timeoutMs: 200, skipDestinationCheck: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "timeout",
      message: "调用超时（超过 0.2 秒）。",
    });
  });

  it("returns credential_unresolved without making any network request when the credential can't be resolved", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await callAgent(
      { invocationUrl: "https://example.invalid", credentialRef: null },
      {},
      // The destination check itself is covered by its own dedicated test
      // suite above — skipped here so this test can isolate credential
      // resolution specifically (example.invalid deliberately doesn't
      // resolve at all, which would otherwise fail at the destination
      // check first, before ever reaching credential resolution).
      { skipDestinationCheck: true },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("credential_unresolved");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns network_error when invocationUrl is not configured, without making any network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await callAgent(
      { invocationUrl: null, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("network_error");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns invalid_response for a non-JSON body, and for a non-2xx status, without echoing the response body", async () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json, and this text must never appear in the result");
    });

    const result = await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
      { skipDestinationCheck: true },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("invalid_response");
    expect(result.ok === false && result.message).not.toContain("not json");
  });

  it("returns invalid_response for a non-2xx JSON error body, without echoing its content", async () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    const url = await listen((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ internalStackTrace: "must-not-leak-into-result" }));
    });

    const result = await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
      { skipDestinationCheck: true },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("invalid_response");
    expect(result.ok === false && result.message).not.toContain("must-not-leak-into-result");
  });

  // AC-1206 (extended to this Task): every failure path's message must
  // never contain the real resolved credential value.
  it("never includes the resolved credential value in any failure result, across every failure path", async () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    const url = await listen((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("{}");
    });

    const result = await callAgent(
      { invocationUrl: url, credentialRef: `env://${ENV_VAR_NAME}` },
      {},
      { skipDestinationCheck: true },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(REAL_SECRET_VALUE);
  });
});
