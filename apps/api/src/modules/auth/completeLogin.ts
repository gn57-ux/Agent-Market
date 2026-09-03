import type { Pool } from "pg";
import type { IdentityProvider } from "./identity-provider.js";
import { issueSession, type IssuedSession } from "./session.service.js";
import { recordLogin } from "./users.store.js";

export type CompleteLoginResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; reason: "not_found" | "already_consumed" | "expired" | "invalid_proof" };

/**
 * Atomically verifies the login proof (via `provider.completeAuth`),
 * records the login, and issues a session — all in one database
 * transaction. Codex review (T-404 round 2, P2): previously nonce
 * consumption, `recordLogin`, and `issueSession` ran as three independent
 * statements/pool calls; if a later one failed after nonce consumption had
 * already committed, the request returned 500 but the nonce was
 * permanently burned with no session issued — the client's only recovery
 * was starting over with a brand-new `/auth/nonce` call, even though their
 * signature was genuinely valid. Wrapping everything in one transaction
 * means a failure anywhere rolls the whole thing back, so the same proof
 * can be retried.
 *
 * F-1601 (T-1600): `provider` is an `IdentityProvider` — this function
 * only ever depends on the interface's `address` output, never on
 * SIWE/Privy specifics. `completeAuth` receives the transaction's own
 * `client` (not `pool`) so its own nonce-consumption (or whatever
 * provider-specific state change verification requires) commits or rolls
 * back together with `recordLogin`/`issueSession`, preserving the exact
 * atomicity this function's original fix established.
 */
export async function completeLogin(
  pool: Pool,
  provider: IdentityProvider,
  address: string,
  nonce: string,
  proof: unknown,
): Promise<CompleteLoginResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const verified = await provider.completeAuth(client, { address, nonce, proof });
    if (!verified.ok) {
      await client.query("ROLLBACK");
      return verified;
    }
    await recordLogin(client, verified.result.address);
    const session = await issueSession(client, verified.result.address);
    await client.query("COMMIT");
    return { ok: true, session };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
