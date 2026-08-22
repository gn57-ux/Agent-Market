import type { Pool } from "pg";
import { normalizeAddress } from "./nonce.store.js";

export interface UserRow {
  address: string;
  createdAt: Date;
  lastLoginAt: Date | null;
}

interface UserQueryRow {
  address: string;
  created_at: Date;
  last_login_at: Date | null;
}

function toUserRow(row: UserQueryRow): UserRow {
  return { address: row.address, createdAt: row.created_at, lastLoginAt: row.last_login_at };
}

/**
 * Minimal user data-access surface — deliberately just enough for T-403's
 * own migration/nonce tests plus what T-404 (POST /auth/verify) needs:
 * create-or-touch a user row on successful login, and look one up.
 *
 * Open question left for T-404: whether a user row should be created only
 * on first successful verify (this module's current behavior, via `ON
 * CONFLICT DO UPDATE`) or earlier. If T-404 needs different semantics, add a
 * separate function here rather than overloading `recordLogin`.
 */
export async function recordLogin(pool: Pool, rawAddress: string): Promise<UserRow> {
  const address = normalizeAddress(rawAddress);
  const { rows } = await pool.query<UserQueryRow>(
    `INSERT INTO users (address, last_login_at)
     VALUES ($1, now())
     ON CONFLICT (address) DO UPDATE SET last_login_at = now()
     RETURNING address, created_at, last_login_at`,
    [address],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("recordLogin: INSERT ... RETURNING produced no row");
  }
  return toUserRow(row);
}

export async function findUserByAddress(pool: Pool, rawAddress: string): Promise<UserRow | null> {
  const address = normalizeAddress(rawAddress);
  const { rows } = await pool.query<UserQueryRow>(
    `SELECT address, created_at, last_login_at FROM users WHERE address = $1`,
    [address],
  );
  const row = rows[0];
  return row ? toUserRow(row) : null;
}
