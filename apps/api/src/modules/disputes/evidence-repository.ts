import type { Queryable } from "../../db/pool.js";

/**
 * Feature 21 (arbitration-committee), T-2108 (F-2110). The one module
 * that knows `dispute_evidence_submissions`'s columns (CLAUDE.md 原则 6).
 * `disputes.evidence_summary` (Feature 10) stays the requester's original
 * filing summary, unchanged by this table — this is strictly the
 * ADDITIONAL, multi-round, multi-party evidence submitted AFTER a dispute
 * is already open.
 */
export interface DisputeEvidenceSubmissionRow {
  id: string;
  disputeId: string;
  submitterAddress: string;
  submitterRole: "REQUESTER" | "AGENT";
  content: string;
  submittedAt: Date;
  sequenceNo: string;
}

function toRow(row: {
  id: string;
  dispute_id: string;
  submitter_address: string;
  submitter_role: "REQUESTER" | "AGENT";
  content: string;
  submitted_at: Date;
  sequence_no: string;
}): DisputeEvidenceSubmissionRow {
  return {
    id: row.id,
    disputeId: row.dispute_id,
    submitterAddress: row.submitter_address,
    submitterRole: row.submitter_role,
    content: row.content,
    submittedAt: row.submitted_at,
    sequenceNo: row.sequence_no,
  };
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface ListDisputeEvidenceSubmissionsResult {
  submissions: DisputeEvidenceSubmissionRow[];
  /** Pass as `after` to fetch the next page; `null` once there are no
   * further real rows past this page. */
  nextCursor: string | null;
}

/**
 * N4 real finding (P1, round 1, T-2108): the caller (`routes.ts`) checks
 * `getOpenDisputeForTask` and THEN calls this function as two separate
 * round trips — if the dispute is resolved (by a concurrent, already-
 * committed `resolveDispute` verification) in between, a naive
 * unconditional `INSERT` would still happily attach new evidence to an
 * already-closed case. The `INSERT ... SELECT ... WHERE EXISTS` form
 * below re-checks `disputes.status = 'OPEN'` as part of the SAME atomic
 * statement as the insert itself — there is no gap between "check" and
 * "write" for another transaction's already-committed resolution to land
 * in. Returns `null` (not a thrown error) when the dispute is not
 * currently OPEN, exactly like `removeMember`/`releaseAgent`'s own
 * "nothing happened, tell the caller so it can decide the HTTP status"
 * convention elsewhere in this codebase.
 */
export async function insertDisputeEvidenceSubmission(
  client: Queryable,
  input: {
    disputeId: string;
    submitterAddress: string;
    submitterRole: "REQUESTER" | "AGENT";
    content: string;
  },
): Promise<DisputeEvidenceSubmissionRow | null> {
  const { rows } = await client.query<{
    id: string;
    dispute_id: string;
    submitter_address: string;
    submitter_role: "REQUESTER" | "AGENT";
    content: string;
    submitted_at: Date;
    sequence_no: string;
  }>(
    `INSERT INTO dispute_evidence_submissions (dispute_id, submitter_address, submitter_role, content)
     SELECT $1, $2, $3, $4
      WHERE EXISTS (SELECT 1 FROM disputes WHERE id = $1 AND status = 'OPEN')
     RETURNING id, dispute_id, submitter_address, submitter_role, content, submitted_at, sequence_no`,
    [input.disputeId, input.submitterAddress.toLowerCase(), input.submitterRole, input.content],
  );
  const row = rows[0];
  return row ? toRow(row) : null;
}

/**
 * F-2110/F-2114: the complete举证 timeline, in real insertion order —
 * ordered by `sequence_no` (a `BIGSERIAL`, assigned atomically at INSERT
 * time), NOT `submitted_at` alone (N4 real finding, P2, round 1: two
 * submissions landing in the same real wall-clock millisecond would
 * otherwise have no deterministic order). "多方多轮" means the caller
 * distinguishes rounds/parties by reading `submitterRole`/`submittedAt`
 * off each row, not by this function grouping them itself.
 *
 * N4 real finding (P2, round 2, T-2108): F-2110 places no cap on how many
 * real rounds either party may submit — an unpaginated read of the full
 * timeline is a real resource-exhaustion path a participant could trigger
 * by submitting enough real rounds. Cursor-paginated on `sequence_no`
 * (never an OFFSET — stays correct and cheap however many pages deep a
 * caller walks, and the `(dispute_id, sequence_no)` index above answers
 * this exact `WHERE ... AND sequence_no > $cursor ORDER BY sequence_no
 * LIMIT $n` shape directly, no separate sort step).
 */
export async function listDisputeEvidenceSubmissions(
  client: Queryable,
  disputeId: string,
  options: { limit?: number; after?: string } = {},
): Promise<ListDisputeEvidenceSubmissionsResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const afterSequenceNo = options.after ?? "0";

  const { rows } = await client.query<{
    id: string;
    dispute_id: string;
    submitter_address: string;
    submitter_role: "REQUESTER" | "AGENT";
    content: string;
    submitted_at: Date;
    sequence_no: string;
  }>(
    `SELECT id, dispute_id, submitter_address, submitter_role, content, submitted_at, sequence_no
       FROM dispute_evidence_submissions
      WHERE dispute_id = $1 AND sequence_no > $2
      ORDER BY sequence_no
      LIMIT $3`,
    [disputeId, afterSequenceNo, limit],
  );
  const submissions = rows.map(toRow);
  const lastRow = submissions[submissions.length - 1];
  return {
    submissions,
    nextCursor: submissions.length === limit && lastRow ? lastRow.sequenceNo : null,
  };
}
