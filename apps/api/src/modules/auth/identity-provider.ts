import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";

/**
 * F-1601 (Feature 16, T-1600) — the login-challenge this provider hands
 * back to the client after `beginAuth`. Shape is intentionally generic
 * (not "a SIWE nonce") so a future non-challenge-based provider (e.g. one
 * that verifies a pre-issued token instead of a nonce/signature pair)
 * could still populate this same contract — `nonce` doubles as "whatever
 * opaque string the client must echo back in `completeAuth`'s input."
 */
export interface AuthChallenge {
  readonly address: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The ONLY thing any `IdentityProvider` implementation is allowed to
 * return on success — F-1602's direct enforcement mechanism. Every
 * implementation (`SiweIdentityProvider` today, `PrivyIdentityProvider` in
 * T-1601) must project its own provider-specific verification result down
 * to this shape before returning; the SDK/proof internals never escape the
 * implementation file. `auth` module callers (`completeLogin.ts`,
 * `routes.ts`) — and every other module in this codebase that consumes a
 * session — only ever see this `address` string, never anything
 * provider-specific.
 */
export interface IdentityVerificationResult {
  readonly address: string;
}

export type CompleteAuthResult =
  | { readonly ok: true; readonly result: IdentityVerificationResult }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "already_consumed" | "expired" | "invalid_proof";
    };

/**
 * F-1601's adapter boundary (design.md 决策 1, 方案 B). `auth` module
 * orchestration (`completeLogin.ts`) depends only on this interface, never
 * on `SiweIdentityProvider`/`PrivyIdentityProvider` directly — swapping the
 * active implementation (or rolling back, F-1603) means changing which
 * implementation the composition root (`app.ts`) constructs, not touching
 * any calling code.
 *
 * `completeAuth` takes a `Queryable` (not `Pool`) so it can participate in
 * a caller-controlled transaction — `completeLogin.ts` needs nonce
 * consumption to commit or roll back atomically together with
 * `recordLogin`/`issueSession` (T-404 round 2, P2's original fix for
 * "nonce burned but no session issued"); moving verification behind this
 * interface must not regress that atomicity.
 */
export interface IdentityProvider {
  beginAuth(pool: Pool, address: string): Promise<AuthChallenge>;
  completeAuth(
    client: Queryable,
    input: { readonly address: string; readonly nonce: string; readonly proof: unknown },
  ): Promise<CompleteAuthResult>;
}
