import type { Queryable } from "../../db/pool.js";

/**
 * Feature 21 (arbitration-committee), T-2107 (F-2106). The one module
 * that knows `arbitration_recusals`'s columns (CLAUDE.md 原则 6). This is
 * a purely ADDITIVE, append-only record of a real human decision ("this
 * committee member is not participating in this dispute due to a
 * conflict of interest") — Safe itself enforces nothing here (design.md's
 * own point: Safe has no native "exclude this owner from this one
 * signature" mechanism), so this table is the entire real enforcement
 * mechanism this Feature provides: a permanent, queryable declaration
 * that a human reviewing a real Safe transaction's signer set can check
 * against before treating a real 2-of-3 execution as free of conflicts.
 */
export interface RecusalRow {
  id: string;
  disputeId: string;
  memberAddress: string;
  reason: string;
  recordedBy: string;
  recordedAt: Date;
}

function toRow(row: {
  id: string;
  dispute_id: string;
  member_address: string;
  reason: string;
  recorded_by: string;
  recorded_at: Date;
}): RecusalRow {
  return {
    id: row.id,
    disputeId: row.dispute_id,
    memberAddress: row.member_address,
    reason: row.reason,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

export type RecordRecusalResult =
  | { ok: true; recusal: RecusalRow }
  | { ok: false; reason: "DUPLICATE" | "DISPUTE_NOT_FOUND" | "MEMBER_NOT_ACTIVE" };

export async function recordRecusal(
  client: Queryable,
  input: { disputeId: string; memberAddress: string; reason: string; recordedBy: string },
): Promise<RecordRecusalResult> {
  // N4 real finding (P2, round 1, T-2107): F-2106's own recusal concept is
  // "a committee MEMBER declines to participate" — an address that was
  // never a real committee member at all cannot meaningfully recuse
  // itself, and letting it through would let a typo or a malicious
  // submission create a fake-looking audit record for someone who was
  // never actually eligible to sign in the first place.
  const { rows: memberRows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM arbitration_committee_members
        WHERE member_address = $1 AND status = 'ACTIVE'
     ) AS exists`,
    [input.memberAddress.toLowerCase()],
  );
  if (!memberRows[0]?.exists) {
    return { ok: false, reason: "MEMBER_NOT_ACTIVE" };
  }

  try {
    const { rows } = await client.query<{
      id: string;
      dispute_id: string;
      member_address: string;
      reason: string;
      recorded_by: string;
      recorded_at: Date;
    }>(
      `INSERT INTO arbitration_recusals (dispute_id, member_address, reason, recorded_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, dispute_id, member_address, reason, recorded_by, recorded_at`,
      [
        input.disputeId,
        input.memberAddress.toLowerCase(),
        input.reason,
        input.recordedBy.toLowerCase(),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("recordRecusal: INSERT ... RETURNING id returned no row");
    return { ok: true, recusal: toRow(row) };
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = (error as { code: string }).code;
      // unique_violation — this exact (dispute, member) pair already has
      // a real recusal recorded.
      if (code === "23505") {
        return { ok: false, reason: "DUPLICATE" };
      }
      // N4 real finding (P2, round 1, T-2107): a syntactically valid but
      // non-existent `disputeId` previously fell through to this
      // function's caller as an unhandled foreign_key_violation (a real
      // 500), while `listRecusalsByDispute` for the SAME nonexistent
      // dispute silently returns an empty array — an inconsistent pair of
      // behaviors for the identical real input.
      if (code === "23503") {
        return { ok: false, reason: "DISPUTE_NOT_FOUND" };
      }
    }
    throw error;
  }
}

export async function listRecusalsByDispute(
  client: Queryable,
  disputeId: string,
): Promise<RecusalRow[]> {
  const { rows } = await client.query<{
    id: string;
    dispute_id: string;
    member_address: string;
    reason: string;
    recorded_by: string;
    recorded_at: Date;
  }>(
    `SELECT id, dispute_id, member_address, reason, recorded_by, recorded_at
       FROM arbitration_recusals
      WHERE dispute_id = $1
      ORDER BY recorded_at`,
    [disputeId],
  );
  return rows.map(toRow);
}
