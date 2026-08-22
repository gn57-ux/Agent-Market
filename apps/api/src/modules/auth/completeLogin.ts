import type { Pool } from "pg";
import { consumeNonce } from "./nonce.store.js";
import { issueSession, type IssuedSession } from "./session.service.js";
import { recordLogin } from "./users.store.js";

export type CompleteLoginResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; reason: "not_found" | "already_consumed" | "expired" };

/**
 * Atomically consumes the nonce, records the login, and issues a session —
 * all three in one database transaction. Codex review (T-404 round 2, P2):
 * previously these ran as three independent statements/pool calls; if
 * `recordLogin` or `issueSession` failed after `consumeNonce` had already
 * committed, the request returned 500 but the nonce was permanently burned
 * with no session issued — the client's only recovery was starting over
 * with a brand-new `/auth/nonce` call, even though their signature was
 * genuinely valid. Wrapping all three in one transaction means a failure
 * anywhere rolls the nonce consumption back too, so the same signature can
 * be retried against the still-valid nonce.
 *
 * Only called from `/auth/verify` (routes.ts) after `verifySignInSignature`
 * has already confirmed the signature is valid — this function itself
 * doesn't re-verify anything, it just makes the three already-decided
 * writes atomic.
 */
export async function completeLogin(
  pool: Pool,
  address: string,
  nonce: string,
): Promise<CompleteLoginResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const consumed = await consumeNonce(client, address, nonce);
    if (!consumed.ok) {
      await client.query("ROLLBACK");
      return consumed;
    }
    await recordLogin(client, address);
    const session = await issueSession(client, address);
    await client.query("COMMIT");
    return { ok: true, session };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
