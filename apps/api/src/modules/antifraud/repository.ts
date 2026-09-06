import type { Queryable } from "../../db/pool.js";
import type { CollusionCandidate, DeliveryHashRecord, RatingCandidate } from "./detection.js";

/**
 * F-2006/T-2005: raw fact-fetching for `detectScoreManipulation` — real
 * `ratings` rows within a lookback window, joined to the Agent that
 * actually completed the rated task (`tasks.accepted_agent_id`) and to the
 * requester's own account age (`users.created_at`) at rating time. This
 * function ONLY reads `ratings`/`tasks`/`users` and never writes anything —
 * `tasks.accepted_agent_id IS NOT NULL` excludes any row that could exist
 * before a task reaches an accepted state (defensive; in practice a rating
 * can't be created before then, see ratings' own FK to a real task).
 *
 * `lookbackDays` only bounds how much rating HISTORY this run scans, not
 * the detector's sensitivity (`detection.ts`'s own config does that) — a
 * daily-run job needs a lookback comfortably wider than the detector's own
 * sliding window (`suspiciousWindowHours`) so a signal can't be missed by
 * scanning too narrow a slice, even if this job runs slightly late.
 */
export async function getRecentRatingCandidates(
  client: Queryable,
  lookbackDays: number,
): Promise<RatingCandidate[]> {
  const { rows } = await client.query<{
    rating_id: string;
    agent_id: string;
    requester_address: string;
    score: number;
    rated_at: Date;
    requester_created_at: Date;
  }>(
    `SELECT r.id AS rating_id, t.accepted_agent_id AS agent_id, r.requester_address,
            r.score, r.created_at AS rated_at, u.created_at AS requester_created_at
       FROM ratings r
       JOIN tasks t ON t.id = r.task_id
       JOIN users u ON u.address = r.requester_address
      WHERE r.created_at >= now() - ($1 || ' days')::interval
        AND t.accepted_agent_id IS NOT NULL`,
    [lookbackDays],
  );
  return rows.map((row) => ({
    ratingId: row.rating_id,
    agentId: row.agent_id,
    requesterAddress: row.requester_address,
    score: row.score,
    ratedAt: row.rated_at,
    requesterCreatedAt: row.requester_created_at,
  }));
}

/**
 * F-2007/T-2006: raw fact-fetching for `detectFakeDelivery` — every
 * `deliverables` row, joined to `tasks.accepted_agent_id` (the real Agent
 * identity, not `deliverables.agent_address`, which is only the owner
 * wallet and can't distinguish which of an owner's several Agents actually
 * submitted — F-501 permits one owner to control multiple Agents). No
 * lookback window (unlike `getRecentRatingCandidates`): F-2007 describes a
 * standing "identical content reused" fact, not a short-burst pattern.
 */
export async function getDeliveryHashRecords(client: Queryable): Promise<DeliveryHashRecord[]> {
  const { rows } = await client.query<{
    deliverable_id: string;
    task_id: string;
    agent_id: string;
    result_hash: string;
  }>(
    `SELECT d.id AS deliverable_id, d.task_id, t.accepted_agent_id AS agent_id, d.result_hash
       FROM deliverables d
       JOIN tasks t ON t.id = d.task_id
      WHERE t.accepted_agent_id IS NOT NULL`,
  );
  return rows.map((row) => ({
    deliverableId: row.deliverable_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    resultHash: row.result_hash,
  }));
}

/**
 * F-2008/T-2006: raw fact-fetching for `detectCollusion` — every real
 * (task, requester, Agent, rating score) tuple. No lookback window, same
 * reasoning as `getDeliveryHashRecords` above.
 */
export async function getRatedTaskPairs(client: Queryable): Promise<CollusionCandidate[]> {
  const { rows } = await client.query<{
    task_id: string;
    requester_address: string;
    agent_id: string;
    score: number;
  }>(
    `SELECT r.task_id, t.requester_address, t.accepted_agent_id AS agent_id, r.score
       FROM ratings r
       JOIN tasks t ON t.id = r.task_id
      WHERE t.accepted_agent_id IS NOT NULL`,
  );
  return rows.map((row) => ({
    taskId: row.task_id,
    requesterAddress: row.requester_address,
    agentId: row.agent_id,
    score: row.score,
  }));
}

/** `pg` reports a unique-constraint violation as SQLSTATE `23505` — same
 * check `disputes/repository.ts`'s own `isUniqueViolation` uses, re-declared
 * here rather than imported for the same reason that module gives (a
 * two-line, well-understood check, not business knowledge worth coupling
 * two otherwise-independent modules over). This table's one relevant unique
 * constraint is `risk_signals_one_open_per_agent_and_type`
 * (0033_add_risk_signals_one_open_per_subject.sql, a partial index on
 * `(signal_type, subject_agent_id) WHERE status IN ('DETECTED',
 * 'UNDER_REVIEW')`), so any `23505` from `insertRiskSignal` below is that
 * constraint — a detector re-run finding an already-open signal for the
 * same (signalType, subjectAgentId) pair. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface InsertRiskSignalInput {
  signalType: "SCORE_MANIPULATION" | "FAKE_DELIVERY" | "COLLUSION" | "DUPLICATE_ACCOUNT";
  subjectAgentId: string | null;
  subjectAddress: string | null;
  evidence: unknown;
}

/**
 * The single writer for `risk_signals` (CLAUDE.md 原则 6) — every detector
 * (T-2005 today; T-2006/T-2007 later) funnels through here rather than each
 * re-deriving the migration's own `risk_signals_has_subject` CHECK
 * (`subject_agent_id IS NOT NULL OR subject_address IS NOT NULL`). Always
 * inserts with the schema's own `status` default (`'DETECTED'`) — this
 * module has no code path that could ever write `CONFIRMED`/`DISMISSED`
 * (design.md 决策 1: only T-2008's admin-gated governance endpoint may).
 *
 * Returns `null` (not a thrown error) when an open signal for the same
 * (signalType, subjectAgentId) already exists — `risk_signals_one_open_
 * per_agent_and_type`'s own uniqueness violation, matching this codebase's
 * `disputes/repository.ts` `insertDispute` precedent exactly. N4 real
 * finding (P2): an earlier version checked "does an open signal already
 * exist" with a separate `SELECT` before this `INSERT` — two overlapping
 * detector runs (this job is meant to be re-run repeatedly, e.g. daily)
 * could both observe "no" before either committed, both insert, and
 * duplicate the supposedly-idempotent signal with no database constraint
 * stopping it. Relying on the database's own unique index instead of an
 * application-level check-then-insert makes this genuinely race-safe.
 */
export async function insertRiskSignal(
  client: Queryable,
  input: InsertRiskSignalInput,
): Promise<string | null> {
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO risk_signals (signal_type, subject_agent_id, subject_address, evidence)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        input.signalType,
        input.subjectAgentId,
        input.subjectAddress,
        JSON.stringify(input.evidence),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("insertRiskSignal: INSERT ... RETURNING id returned no row");
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/**
 * F-2010/T-2008: the admin-facing risk-signal queue —
 * `GET /admin/risk-signals`'s own read path. `statusFilter` is optional
 * (an admin browsing everything vs only the still-actionable queue); no
 * lookback window — a signal stays relevant until an admin resolves it,
 * regardless of when it was detected.
 *
 * Paginated (N4 real finding, P2): `risk_signals` is continuously appended
 * to by periodic detector runs (T-2005/T-2006, more to follow) and
 * resolved rows are never deleted, so an unbounded listing would eventually
 * return unbounded rows and `evidence` JSONB blobs as the table grows. Same
 * shape as this codebase's established pagination convention
 * (`tasks/repository.ts`'s `listTasks`): `total` from an INDEPENDENT
 * `count(*)` query using the identical WHERE clause (a page beyond the
 * last populated one must still report the real total, not 0 from an
 * empty-page window function), ordered by `detected_at DESC, id DESC` so
 * pagination stays deterministic even when two signals share a timestamp.
 */
export interface RiskSignalRow {
  id: string;
  signalType: string;
  subjectAgentId: string | null;
  subjectAddress: string | null;
  evidence: unknown;
  status: string;
  detectedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export interface ListRiskSignalsResult {
  items: RiskSignalRow[];
  total: number;
}

export async function getRiskSignals(
  client: Queryable,
  filter: { status?: string; page: number; pageSize: number },
): Promise<ListRiskSignalsResult> {
  const offset = (filter.page - 1) * filter.pageSize;
  const statusFilter = filter.status ?? null;

  const [itemsResult, countResult] = await Promise.all([
    client.query<{
      id: string;
      signal_type: string;
      subject_agent_id: string | null;
      subject_address: string | null;
      evidence: unknown;
      status: string;
      detected_at: Date;
      reviewed_by: string | null;
      reviewed_at: Date | null;
    }>(
      `SELECT id, signal_type, subject_agent_id, subject_address, evidence, status, detected_at, reviewed_by, reviewed_at
         FROM risk_signals
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY detected_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [statusFilter, filter.pageSize, offset],
    ),
    client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM risk_signals WHERE ($1::text IS NULL OR status = $1)`,
      [statusFilter],
    ),
  ]);

  return {
    items: itemsResult.rows.map((row) => ({
      id: row.id,
      signalType: row.signal_type,
      subjectAgentId: row.subject_agent_id,
      subjectAddress: row.subject_address,
      evidence: row.evidence,
      status: row.status,
      detectedAt: row.detected_at,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
    })),
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

/**
 * F-2010/T-2008: the single writer for resolving a risk signal
 * (`CONFIRMED`/`DISMISSED`, CLAUDE.md 原则 6). The `WHERE status IN
 * ('DETECTED', 'UNDER_REVIEW')` guard makes this one atomic statement
 * genuinely race-safe by construction (Postgres row-level locking on the
 * UPDATE itself) — the SAME class of TOCTOU bug already found and fixed
 * twice this Feature (T-2002's review endpoint, T-2005/T-2006's detector
 * dedup) never has a chance to exist here, because there is no separate
 * read-then-write step at all: two concurrent resolve attempts on the same
 * row can only ever have one of them actually match this WHERE clause.
 * Returns `null` (not a thrown error) when no row matched — the caller
 * (admin-routes.ts) does a follow-up read only to decide 404 vs 409 for the
 * error message, which cannot affect correctness since the real state
 * transition already deterministically happened-or-didn't in this one
 * statement.
 *
 * **F-2010's own explicit boundary, still honored here**: this function
 * ONLY ever writes to `risk_signals` itself — never `agents`/`tasks`/any
 * chain-transaction table. AC-2003's "才触发实际的状态变更（如临时降权或
 * 标记）" downstream consequence on the Agent is Q-2003's unresolved
 * question (which governance process, how many approvers, whether Feature
 * 21's arbitration committee is involved) — T-2008 is deliberately DONE
 * only up through recording an admin's CONFIRMED/DISMISSED judgment, not
 * through any actual punishment action, matching the user's explicit
 * instruction not to invent Q-2003's answer.
 */
export async function resolveRiskSignal(
  client: Queryable,
  id: string,
  status: "CONFIRMED" | "DISMISSED",
  reviewedBy: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE risk_signals
        SET status = $2, reviewed_by = $3, reviewed_at = now()
      WHERE id = $1 AND status IN ('DETECTED', 'UNDER_REVIEW')
      RETURNING id`,
    [id, status, reviewedBy],
  );
  return rows[0]?.id ?? null;
}

export async function getRiskSignalById(
  client: Queryable,
  id: string,
): Promise<RiskSignalRow | null> {
  const { rows } = await client.query<{
    id: string;
    signal_type: string;
    subject_agent_id: string | null;
    subject_address: string | null;
    evidence: unknown;
    status: string;
    detected_at: Date;
    reviewed_by: string | null;
    reviewed_at: Date | null;
  }>(
    `SELECT id, signal_type, subject_agent_id, subject_address, evidence, status, detected_at, reviewed_by, reviewed_at
       FROM risk_signals WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    signalType: row.signal_type,
    subjectAgentId: row.subject_agent_id,
    subjectAddress: row.subject_address,
    evidence: row.evidence,
    status: row.status,
    detectedAt: row.detected_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  };
}
