import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialResolutionError,
  computeCredentialRef,
  resolveCredential,
} from "./credential.js";

// A real 32-hex-char id shape (T-1300: credentialRef is now always
// `env://AGENT_` + a specific Agent's own id with dashes stripped and hex
// uppercased) — matches what computeCredentialRef actually produces for a
// real UUID.
const FAKE_AGENT_ID = "3f2a9c7b-1e4d-4f2a-8b3c-1d2e3f4a5b6c";
const ENV_VAR_NAME = `AGENT_${FAKE_AGENT_ID.replace(/-/g, "").toUpperCase()}`;
// A real, distinctive secret-shaped string — used to prove it never leaks
// into any error message (AC-1206), not just that resolveCredential's
// return type "looks like" it doesn't expose secrets.
const REAL_SECRET_VALUE = "sk-live-do-not-leak-3f2a9c7b1e";

afterEach(() => {
  delete process.env[ENV_VAR_NAME];
});

describe("computeCredentialRef", () => {
  it("is deterministic: the same id always produces the same reference", () => {
    expect(computeCredentialRef(FAKE_AGENT_ID)).toBe(computeCredentialRef(FAKE_AGENT_ID));
  });

  it("produces a reference matching the exact env://AGENT_<id> shape resolveCredential expects", () => {
    expect(computeCredentialRef(FAKE_AGENT_ID)).toBe(`env://${ENV_VAR_NAME}`);
  });

  it("produces different references for different ids (no two Agents can ever collide)", () => {
    const otherId = "00000000-0000-0000-0000-000000000000";
    expect(computeCredentialRef(FAKE_AGENT_ID)).not.toBe(computeCredentialRef(otherId));
  });
});

describe("resolveCredential", () => {
  it("resolves the referenced environment variable's real value", () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;
    expect(resolveCredential(computeCredentialRef(FAKE_AGENT_ID))).toBe(REAL_SECRET_VALUE);
  });

  it("rejects a null credentialRef (no credential configured) without touching process.env", () => {
    expect(() => resolveCredential(null)).toThrow(CredentialResolutionError);
  });

  it("rejects a credentialRef that doesn't match the env://AGENT_<32-hex> shape", () => {
    expect(() => resolveCredential("not-a-reference")).toThrow(CredentialResolutionError);
    expect(() => resolveCredential("http://also-not-a-reference")).toThrow(
      CredentialResolutionError,
    );
    // Codex review (T-1300 round 1, P1): the pre-fix pattern accepted any
    // owner-chosen free text after `AGENT_` — that's exactly the
    // front-running vector this Task closed. A human-readable suffix (not
    // a real 32-hex id) must now be rejected, not merely "well-formed".
    expect(() => resolveCredential("env://AGENT_MY_OWN_KEY_NAME")).toThrow(
      CredentialResolutionError,
    );
    expect(() => resolveCredential(`env://agent_${FAKE_AGENT_ID.replace(/-/g, "")}`)).toThrow(
      CredentialResolutionError,
    );
  });

  // Codex review (T-1203 round 1, P1): defense-in-depth layer 3 (this
  // function must not trust that every caller went through schema.ts's own
  // AGENT_-prefix check) — proves resolveCredential itself refuses to
  // resolve an arbitrary process environment variable even if it is
  // otherwise env://-shaped.
  it("rejects an env:// reference that doesn't start with AGENT_, even if the target variable genuinely exists (P1 regression: arbitrary env-var exfiltration)", () => {
    process.env.PATH_LOOKS_LIKE_A_REAL_SECRET = REAL_SECRET_VALUE;
    try {
      expect(() => resolveCredential("env://PATH_LOOKS_LIKE_A_REAL_SECRET")).toThrow(
        CredentialResolutionError,
      );
    } finally {
      delete process.env.PATH_LOOKS_LIKE_A_REAL_SECRET;
    }
  });

  it("rejects a credentialRef that is exactly the AGENT_ prefix with an empty suffix", () => {
    expect(() => resolveCredential("env://AGENT_")).toThrow(CredentialResolutionError);
  });

  it("rejects a well-formed reference whose target environment variable is unset", () => {
    expect(() => resolveCredential(computeCredentialRef(FAKE_AGENT_ID))).toThrow(
      CredentialResolutionError,
    );
  });

  it("rejects a well-formed reference whose target environment variable is empty", () => {
    process.env[ENV_VAR_NAME] = "";
    expect(() => resolveCredential(computeCredentialRef(FAKE_AGENT_ID))).toThrow(
      CredentialResolutionError,
    );
  });

  // AC-1206: the real secret value must never appear in any error message
  // across every failure path this function has — constructed with a real,
  // distinctive value and asserted against the full text of every thrown
  // error, not just spot-checked.
  it("never includes the real credential value in any thrown error message, across every failure path", () => {
    process.env[ENV_VAR_NAME] = REAL_SECRET_VALUE;

    const attempts: Array<() => void> = [
      () => resolveCredential(null),
      () => resolveCredential("not-a-reference"),
      () => resolveCredential(`${computeCredentialRef(FAKE_AGENT_ID)}_DOES_NOT_EXIST`),
      // Codex review (T-1202 round 1, P1): the exact leak scenario —
      // `credentialRef` itself is a raw, real-secret-shaped string (bypassed
      // schema.ts's format check via a direct database write, or a future
      // code path) rather than a genuine env:// reference. The pre-fix
      // format-mismatch branch echoed this argument verbatim.
      () => resolveCredential(REAL_SECRET_VALUE),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error("expected resolveCredential to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialResolutionError);
        expect((error as Error).message).not.toContain(REAL_SECRET_VALUE);
      }
    }

    // Also verify the successful resolution path itself never logs/throws
    // the value anywhere it shouldn't — the only place it may appear is
    // this function's own return value.
    const resolved = resolveCredential(computeCredentialRef(FAKE_AGENT_ID));
    expect(resolved).toBe(REAL_SECRET_VALUE);
  });
});
