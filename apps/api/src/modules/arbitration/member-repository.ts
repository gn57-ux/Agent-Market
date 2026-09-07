import type { Queryable } from "../../db/pool.js";

/**
 * Feature 21 (arbitration-committee), T-2106 (F-2104; design.md"安全与
 * 兼容性"). The one module that knows `arbitration_committee_members`'s
 * columns (CLAUDE.md 原则 6). This is the LINK-OFF-CHAIN NAME REGISTRY
 * only — the real authority on "who can actually co-sign a Safe
 * transaction" is the Safe contract's own on-chain owner set; this table
 * exists so the platform has a queryable, audited record of intended
 * membership, matching design.md's own explicit warning that the two
 * must be kept in sync by whoever operates the real Safe (a real Safe
 * owner-swap transaction is a SEPARATE, manual on-chain action this
 * repository never performs).
 */
export interface CommitteeMemberRow {
  id: string;
  memberAddress: string;
  status: "ACTIVE" | "REMOVED";
  addedBy: string;
  addedAt: Date;
  removedBy: string | null;
  removedAt: Date | null;
}

function toRow(row: {
  id: string;
  member_address: string;
  status: "ACTIVE" | "REMOVED";
  added_by: string;
  added_at: Date;
  removed_by: string | null;
  removed_at: Date | null;
}): CommitteeMemberRow {
  return {
    id: row.id,
    memberAddress: row.member_address,
    status: row.status,
    addedBy: row.added_by,
    addedAt: row.added_at,
    removedBy: row.removed_by,
    removedAt: row.removed_at,
  };
}

export interface AddMemberResult {
  /** `false` when this address already has an ACTIVE row — the migration's
   * own `arbitration_committee_members_unique_active_address` partial
   * unique index is the real source of truth this checks against (a
   * unique-violation error, not a pre-check race). */
  ok: boolean;
  member?: CommitteeMemberRow;
}

export async function addMember(
  client: Queryable,
  input: { memberAddress: string; addedBy: string },
): Promise<AddMemberResult> {
  try {
    const { rows } = await client.query<{
      id: string;
      member_address: string;
      status: "ACTIVE" | "REMOVED";
      added_by: string;
      added_at: Date;
      removed_by: string | null;
      removed_at: Date | null;
    }>(
      `INSERT INTO arbitration_committee_members (member_address, added_by)
       VALUES ($1, $2)
       RETURNING id, member_address, status, added_by, added_at, removed_by, removed_at`,
      [input.memberAddress.toLowerCase(), input.addedBy.toLowerCase()],
    );
    const row = rows[0];
    if (!row) throw new Error("addMember: INSERT ... RETURNING id returned no row");
    return { ok: true, member: toRow(row) };
  } catch (error) {
    // Postgres unique_violation — the real DB constraint, not a
    // pre-check-then-insert race this code would otherwise be exposed to.
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
      return { ok: false };
    }
    throw error;
  }
}

export interface RemoveMemberResult {
  /** `false` when this address has no current ACTIVE row to remove. */
  ok: boolean;
}

export async function removeMember(
  client: Queryable,
  input: { memberAddress: string; removedBy: string },
): Promise<RemoveMemberResult> {
  const { rowCount } = await client.query(
    `UPDATE arbitration_committee_members
        SET status = 'REMOVED', removed_by = $1, removed_at = now()
      WHERE member_address = $2 AND status = 'ACTIVE'`,
    [input.removedBy.toLowerCase(), input.memberAddress.toLowerCase()],
  );
  return { ok: (rowCount ?? 0) > 0 };
}

export type ReplaceMemberResult =
  | { ok: true; member: CommitteeMemberRow }
  | { ok: false; reason: "OLD_NOT_ACTIVE" | "NEW_ALREADY_ACTIVE" };

/**
 * N4 real finding (P1, round 1, T-2106): requirements.md/design.md both
 * name "加入/退出/替换" as the three real committee-membership
 * operations — a client issuing separate `remove` then `add` calls is
 * NOT the same operation: a failure or a concurrent request between the
 * two steps can leave the off-chain roster with the old member already
 * removed but the replacement never added, silently under-counting a
 * real committee mid-operation. `replaceMember` performs both real
 * writes on the SAME `client` the caller must have already wrapped in a
 * transaction (`admin-routes.ts`'s own `BEGIN`/`COMMIT`/`ROLLBACK`,
 * matching `risk-hold/admin-routes.ts`'s established convention) — either
 * both real rows change together, or neither does.
 */
export async function replaceMember(
  client: Queryable,
  input: { oldMemberAddress: string; newMemberAddress: string; actorAddress: string },
): Promise<ReplaceMemberResult> {
  const removed = await removeMember(client, {
    memberAddress: input.oldMemberAddress,
    removedBy: input.actorAddress,
  });
  if (!removed.ok) {
    return { ok: false, reason: "OLD_NOT_ACTIVE" };
  }
  const added = await addMember(client, {
    memberAddress: input.newMemberAddress,
    addedBy: input.actorAddress,
  });
  if (!added.ok || !added.member) {
    return { ok: false, reason: "NEW_ALREADY_ACTIVE" };
  }
  return { ok: true, member: added.member };
}

/** F-2114：成员变更审计——本表自身已经是名册+历史的合一记录（`REMOVED` 行
 * 永久保留，从不物理删除），因此"审计日志"就是这张表本身按
 * `added_at`/`removed_at` 排序的完整历史，不需要另建一张审计表。 */
export async function listMembers(client: Queryable): Promise<CommitteeMemberRow[]> {
  const { rows } = await client.query<{
    id: string;
    member_address: string;
    status: "ACTIVE" | "REMOVED";
    added_by: string;
    added_at: Date;
    removed_by: string | null;
    removed_at: Date | null;
  }>(
    `SELECT id, member_address, status, added_by, added_at, removed_by, removed_at
       FROM arbitration_committee_members
      ORDER BY added_at DESC`,
  );
  return rows.map(toRow);
}
