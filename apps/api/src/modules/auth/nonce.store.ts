import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_TTL_INTERVAL_SQL = "10 minutes";

export class InvalidAddressError extends Error {
  constructor(address: string) {
    super(`Not a valid Ethereum address: ${address}`);
    this.name = "InvalidAddressError";
  }
}

/**
 * Ethereum addresses are conventionally checksummed mixed-case (EIP-55) but
 * two differently-cased strings identify the same address. This module
 * normalizes to lowercase at every read/write boundary — callers (T-404's
 * routes.ts/session.service.ts, and users.store.ts) must go through this
 * function rather than re-implementing normalization, so "same wallet, two
 * DB rows" can't happen. The `users`/`auth_nonces` CHECK constraints
 * (migrations 0001/0002) additionally require lowercase-hex format as a
 * data-layer backstop.
 */
export function normalizeAddress(address: string): string {
  if (!ETH_ADDRESS_PATTERN.test(address)) {
    throw new InvalidAddressError(address);
  }
  return address.toLowerCase();
}

export interface IssuedNonce {
  address: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Issues a new one-time nonce for `address`.
 *
 * Policy: issuing a new nonce supersedes (marks `consumed`) any previous
 * unconsumed nonce for the same address, so at most one nonce is ever
 * outstanding per address. Chosen over "allow multiple outstanding nonces"
 * because:
 *   - It removes ambiguity about which of several nonces is "the" valid
 *     challenge for `/auth/verify` to expect.
 *   - It matches the expected UX: a client calling `/auth/nonce` again
 *     (e.g. after a stale MetaMask prompt or a page reload) wants a fresh
 *     challenge, not a second still-valid one sitting around.
 *   - It keeps the partial index on `auth_nonces (address) WHERE consumed =
 *     false` (migration 0002) cheap regardless of how many times a client
 *     re-requests a nonce.
 */
export async function issueNonce(pool: Pool, rawAddress: string): Promise<IssuedNonce> {
  const address = normalizeAddress(rawAddress);
  const nonce = randomBytes(32).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE auth_nonces SET consumed = true, consumed_at = now()
       WHERE address = $1 AND consumed = false`,
      [address],
    );
    const { rows } = await client.query<{ issued_at: Date; expires_at: Date }>(
      `INSERT INTO auth_nonces (address, nonce, expires_at)
       VALUES ($1, $2, now() + interval '${NONCE_TTL_INTERVAL_SQL}')
       RETURNING issued_at, expires_at`,
      [address, nonce],
    );
    await client.query("COMMIT");
    const row = rows[0];
    if (!row) {
      throw new Error("issueNonce: INSERT ... RETURNING produced no row");
    }
    return { address, nonce, issuedAt: row.issued_at, expiresAt: row.expires_at };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ConsumeNonceResult =
  { ok: true } | { ok: false; reason: "not_found" | "already_consumed" | "expired" };

/**
 * Atomically consumes a nonce for one-time use (F-405: "nonce 使用后立即失效，
 * 不可重复验证"). The single `UPDATE ... WHERE consumed = false RETURNING`
 * statement is the standard Postgres-safe way to make "consume" race-safe:
 * if two `/auth/verify` requests race on the same nonce, Postgres row-level
 * locking on the UPDATE guarantees only one of them finds the row still
 * `consumed = false` — the other gets zero rows back, i.e. `ok: false`.
 *
 * On the (rare) failure path, one extra SELECT distinguishes why —
 * not_found / already_consumed / expired — so T-404's routes.ts can log or
 * respond precisely without re-deriving nonce-state logic itself (this
 * module owns that knowledge; CLAUDE.md 原则 6: 设计知识只能有一个归属).
 */
export async function consumeNonce(
  pool: Pool,
  rawAddress: string,
  nonce: string,
): Promise<ConsumeNonceResult> {
  const address = normalizeAddress(rawAddress);
  const { rows } = await pool.query<{ id: number }>(
    `UPDATE auth_nonces
     SET consumed = true, consumed_at = now()
     WHERE address = $1 AND nonce = $2 AND consumed = false AND expires_at > now()
     RETURNING id`,
    [address, nonce],
  );
  if (rows.length > 0) {
    return { ok: true };
  }

  const { rows: existing } = await pool.query<{ consumed: boolean; expires_at: Date }>(
    `SELECT consumed, expires_at FROM auth_nonces WHERE address = $1 AND nonce = $2`,
    [address, nonce],
  );
  const found = existing[0];
  if (!found) {
    return { ok: false, reason: "not_found" };
  }
  if (found.consumed) {
    return { ok: false, reason: "already_consumed" };
  }
  return { ok: false, reason: "expired" };
}
