import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { normalizeAddress } from "./nonce.store.js";

const SESSION_TTL_INTERVAL_SQL = "24 hours";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedSession {
  /** Raw bearer token. Returned exactly once, here — never persisted or
   * logged in this form (see migration 0003's header comment). Callers
   * (routes.ts) must not write this to application logs. */
  token: string;
  address: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Issues a new session for `address` after a successful `/auth/verify`.
 * Only `sessions` (this module's own scope). Validating a presented token
 * or revoking a session (`/auth/logout` + the protected-route middleware
 * design.md assigns to T-405) is deliberately not implemented here — this
 * module only needs to ISSUE sessions for T-404's own scope; T-405 owns
 * consuming what this table stores.
 *
 * Design call (two approaches considered, per project rule requiring a
 * comparison for a new shared data model):
 *
 * A. Stateless signed token (e.g. HMAC/JWT over address+expiry, verified
 *    without a DB round-trip). Cheaper to verify per-request, but AC-404
 *    ("登出后受保护接口拒绝该会话的请求") requires revoking one specific
 *    session before its natural expiry — a stateless token can't do that
 *    without ALSO maintaining a server-side revocation list, which is the
 *    same storage requirement as option B plus a second mechanism layered
 *    on top.
 * B. Server-side session row per login, looked up by a hashed token on each
 *    protected request (chosen). One PostgreSQL table — reusing the
 *    database this Feature's other storage (users/auth_nonces) already
 *    established, avoiding a second infrastructure dependency (Redis, a
 *    JWT library) per this project's "stay lean until proven otherwise"
 *    rule — directly supports revocation (T-405 sets `revoked_at`) with no
 *    second mechanism.
 *
 * Chose B: it is the simpler design once revocation is a real requirement
 * (AC-404), not just cheaper to build first.
 */
export async function issueSession(pool: Pool, rawAddress: string): Promise<IssuedSession> {
  const address = normalizeAddress(rawAddress);
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const { rows } = await pool.query<{ issued_at: Date; expires_at: Date }>(
    `INSERT INTO sessions (token_hash, address, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_TTL_INTERVAL_SQL}')
     RETURNING issued_at, expires_at`,
    [tokenHash, address],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("issueSession: INSERT ... RETURNING produced no row");
  }
  return { token, address, issuedAt: row.issued_at, expiresAt: row.expires_at };
}
