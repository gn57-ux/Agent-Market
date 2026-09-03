import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";

/**
 * F-1606/design.md: the ONLY place this codebase decides "is this address
 * an admin" — `app.requireAdmin` (middleware.ts) is the sole caller for
 * request-time authorization, but this is exported separately (not
 * inlined into the middleware) so a future caller that genuinely needs the
 * same fact outside an HTTP request (a script, a background job) reads the
 * same single source of truth instead of re-deriving it. Runtime table
 * query only — never env vars, never a self-reported claim from the
 * request (design.md 决策/T-1607: "admin_roles 表本身保持'运行时查表'这一
 * 单一权限判定路径不被引导逻辑污染").
 */
export async function isAdminAddress(pool: Queryable, address: string): Promise<boolean> {
  const { rows } = await pool.query<{ address: string }>(
    `SELECT address FROM admin_roles WHERE address = $1`,
    [address],
  );
  return rows.length > 0;
}

export interface AdminRoleRow {
  address: string;
  grantedBy: string;
  grantedAt: Date;
}

/**
 * Grants `targetAddress` admin access. `INSERT ... ON CONFLICT DO NOTHING`
 * (same idempotent-insert idiom as `consumePrivyAccessToken`,
 * privy-identity-provider.ts) rather than a separate existence check first
 * — a check-then-insert would leave a race window where two concurrent
 * grants for the same address could both see "not yet admin" and both
 * proceed, one of them then writing a misleading `granted_by`/audit row for
 * a grant that didn't actually change anything. The INSERT and its audit
 * row commit together in one transaction; a grant that turns out to be a
 * no-op (already admin) writes neither.
 */
export async function grantAdminRole(
  pool: Pool,
  targetAddress: string,
  actorAddress: string,
): Promise<{ ok: true; role: AdminRoleRow } | { ok: false; reason: "already_admin" }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ address: string; granted_by: string; granted_at: Date }>(
      `INSERT INTO admin_roles (address, granted_by) VALUES ($1, $2)
       ON CONFLICT (address) DO NOTHING
       RETURNING address, granted_by, granted_at`,
      [targetAddress, actorAddress],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_admin" };
    }
    await client.query(
      `INSERT INTO admin_role_audit_logs (target_address, action, actor_address)
       VALUES ($1, 'GRANT', $2)`,
      [targetAddress, actorAddress],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      role: { address: row.address, grantedBy: row.granted_by, grantedAt: row.granted_at },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Revokes `targetAddress`'s admin access.
 *
 * Codex review (T-1607 round 1, P2): revoking the last remaining admin
 * would leave `admin_roles` empty, permanently 403-ing every
 * `app.requireAdmin`-gated endpoint (including this one) — recoverable
 * only via `admin-bootstrap.ts`'s direct-DB-write escape hatch, which
 * defeats the point of `POST`/`DELETE /admin/roles` being ordinary,
 * self-service admin operations. Fixed by refusing a revoke that would
 * empty the table.
 *
 * `SELECT ... FOR UPDATE` over EVERY current row (not a `SELECT count(*)`,
 * which cannot itself take `FOR UPDATE`) closes the same race class as
 * `setAgentPricingType` (agents/repository.ts's own doc comment): two
 * concurrent revokes of two DIFFERENT admins, with exactly two admins
 * existing, could each independently observe "one other admin remains"
 * from a snapshot that doesn't yet see the other's in-flight delete, and
 * both commit — leaving zero. Locking every row up front forces the
 * second transaction to wait until the first commits or rolls back, so
 * its own re-check always sees the first's real outcome.
 */
export async function revokeAdminRole(
  pool: Pool,
  targetAddress: string,
  actorAddress: string,
): Promise<{ ok: true } | { ok: false; reason: "not_admin" | "last_admin" }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: lockedRows } = await client.query<{ address: string }>(
      `SELECT address FROM admin_roles FOR UPDATE`,
    );
    const exists = lockedRows.some((row) => row.address === targetAddress);
    if (!exists) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_admin" };
    }
    if (lockedRows.length <= 1) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "last_admin" };
    }
    await client.query(`DELETE FROM admin_roles WHERE address = $1`, [targetAddress]);
    await client.query(
      `INSERT INTO admin_role_audit_logs (target_address, action, actor_address)
       VALUES ($1, 'REVOKE', $2)`,
      [targetAddress, actorAddress],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
