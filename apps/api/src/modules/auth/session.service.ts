import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../../db/pool.js";
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
export async function issueSession(pool: Queryable, rawAddress: string): Promise<IssuedSession> {
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

export interface VerifiedSession {
  address: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Verifies a presented bearer token: valid iff a session row exists whose
 * hash matches, that hasn't expired, and hasn't been revoked. T-405's
 * `session.middleware.ts` is the only intended caller — this is the "当前
 * 登录地址" lookup design.md says every later Feature's protected route
 * depends on (CLAUDE.md 原则 6: 设计知识只能有一个归属 — no route handler
 * anywhere should query `sessions` directly).
 */
export async function verifySession(
  pool: Queryable,
  rawToken: string,
): Promise<VerifiedSession | null> {
  const tokenHash = hashToken(rawToken);
  const { rows } = await pool.query<{ address: string; issued_at: Date; expires_at: Date }>(
    `SELECT address, issued_at, expires_at FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? { address: row.address, issuedAt: row.issued_at, expiresAt: row.expires_at } : null;
}

/**
 * Revokes a session (F-404 `/auth/logout`, AC-404). Idempotent — revoking
 * an already-revoked, expired, or unknown token is not an error (logout is
 * inherently "make sure this session can't be used again"; a token that
 * already can't be used satisfies that whether or not this UPDATE actually
 * matched a row, so routes.ts doesn't need to branch on the result).
 */
export async function revokeSession(pool: Queryable, rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
}
