import { z } from "zod";
import type { Queryable } from "../../db/pool.js";
import type { RuleBasedCriteria } from "./rule-scorer.js";

const keywordPresenceCriteriaSchema = z.object({
  type: z.literal("KEYWORD_PRESENCE"),
  // N4 real finding (P2, round 1): a blank/whitespace-only keyword makes
  // `String.prototype.includes("")` (or a whitespace-only needle against
  // any real text with whitespace) trivially true for EVERY submission —
  // a malformed rubric like `["" ]` would score any answer 100. `.trim()`
  // + `.min(1)` rejects that shape at the boundary, not just at scoring
  // time (a rubric this malformed should never be treated as valid input
  // at all).
  requiredKeywords: z.array(z.string().trim().min(1)),
});

/**
 * `evaluation_rubrics.criteria` is a JSONB column — a real system boundary
 * (this codebase's own convention, matching `dispatch.client.ts`'s
 * `matchResponseSchema`: an unchecked `as RuleBasedCriteria` cast would
 * trust the database's stored shape blindly). Only `KEYWORD_PRESENCE` is
 * defined today (`rule-scorer.ts`'s own design comparison); a rubric whose
 * `scoring_mode = 'RULE_BASED'` but whose `criteria` doesn't parse is a
 * real data-integrity problem the caller (T-2001's submission handler)
 * must surface, not silently coerce.
 */
export function parseRuleBasedCriteria(raw: unknown): RuleBasedCriteria | null {
  const parsed = keywordPresenceCriteriaSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface EvaluationTaskRow {
  id: string;
  rubricId: string;
  scoringMode: "RULE_BASED" | "HUMAN_REQUIRED";
  criteria: unknown;
}

export async function getEvaluationTaskById(
  client: Queryable,
  evaluationTaskId: string,
): Promise<EvaluationTaskRow | null> {
  const { rows } = await client.query<{
    id: string;
    rubric_id: string;
    scoring_mode: "RULE_BASED" | "HUMAN_REQUIRED";
    criteria: unknown;
  }>(
    `SELECT et.id, et.rubric_id, et.scoring_mode, er.criteria
       FROM evaluation_tasks et
       JOIN evaluation_rubrics er ON er.id = et.rubric_id
      WHERE et.id = $1`,
    [evaluationTaskId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    rubricId: row.rubric_id,
    scoringMode: row.scoring_mode,
    criteria: row.criteria,
  };
}

export interface InsertSubmissionInput {
  evaluationTaskId: string;
  agentId: string;
  submittedContent: string;
}

export async function insertSubmission(
  client: Queryable,
  input: InsertSubmissionInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO evaluation_submissions (evaluation_task_id, agent_id, submitted_content)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.evaluationTaskId, input.agentId, input.submittedContent],
  );
  const row = rows[0];
  if (!row) throw new Error("insertSubmission: INSERT ... RETURNING id returned no row");
  return row.id;
}

export interface InsertResultInput {
  submissionId: string;
  scoredBy: "RULE" | "AI" | "HUMAN";
  reviewerAddress: string | null;
  score: number;
  rationale: string;
}

/**
 * The single writer for `evaluation_results` (CLAUDE.md 原则 6) — T-2001
 * (RULE), T-2002/T-2004 (HUMAN), and a future T-2003 (AI) all funnel
 * through here rather than each re-deriving the `reviewer_address`
 * NULL/NOT NULL pairing the migration's own CHECK constraint requires
 * (0031_create_evaluation_tables.sql's `evaluation_results_reviewer_
 * matches_scored_by`) — this function still passes both values straight
 * through and lets the database enforce correctness rather than
 * duplicating that rule here (single source of truth stays the schema).
 */
export async function insertResult(client: Queryable, input: InsertResultInput): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO evaluation_results (submission_id, scored_by, reviewer_address, score, rationale)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.submissionId, input.scoredBy, input.reviewerAddress, input.score, input.rationale],
  );
  const row = rows[0];
  if (!row) throw new Error("insertResult: INSERT ... RETURNING id returned no row");
  return row.id;
}

/**
 * F-2012/T-2009 (design.md 决策 3): the passing bar for `agents.baseline_
 * evaluation_status` to move to `PASSED`.
 *
 * **用户 2026-09-06 Q-2001 决策：60/100，运营人工题库方案**（首批 10-20
 * 题，覆盖 2-3 个主要 category）。这不再是占位值——真实题库由
 * `scripts/seed-baseline-evaluation-tasks.ts` 录入，及格线数值由用户直接
 * 确认。此前一版（N4 round 1）把这同一个常量当作未经验证的猜测自动接入
 * 生产路径，Codex 正确指出这是真实风险；现在数值本身已由用户拍板，风险
 * 点转移到"何时对存量 Agent 生效"——见 `EVALUATION_BASELINE_GATE_ENV_VAR`
 * 与 `services/dispatch`（Go）`eligibility.Filter` 的条件 8：即使这个函数
 * 现在无条件地写 `baseline_evaluation_status`，Go 端是否真的把它当作撮合
 * 硬过滤条件仍然由一个默认关闭的开关控制，两者是独立的两道防线（写入 vs
 * 强制生效），缺一都不够安全。
 */
export const BASELINE_EVALUATION_PASSING_SCORE = 60;

/**
 * F-2012/T-2009: the single writer for `agents.baseline_evaluation_status`
 * (CLAUDE.md 原则 6). Called from every real evaluation-completion write
 * path that produces a RULE or HUMAN result (`evaluation/routes.ts`'s
 * `RULE_BASED` submit, `evaluation/admin-routes.ts`'s human review and
 * resolve-appeal endpoints) in the SAME transaction as `insertResult` —
 * NEVER from the AI-suggestion path (T-2003's advisory `scored_by = 'AI'`
 * rows must never move this gate; only a RULE/HUMAN result is a real
 * terminal decision). A CASE expression, not a read-then-write — once
 * `PASSED`, a later lower-scoring result (e.g. a different submission, or
 * an appeal that legitimately re-reviews DOWN) never revokes it: F-2012
 * describes a one-way admission gate an Agent clears once, not a
 * continuously-recomputed standing that could flap an already-dispatching
 * Agent back out of eligibility from an unrelated evaluation event.
 */
export async function updateBaselineEvaluationStatusForResult(
  client: Queryable,
  agentId: string,
  score: number,
): Promise<void> {
  // N4-lesson real bug, caught by this Task's own end-to-end test (a real
  // score of 100 against the real threshold 60): `pg` sends untyped query
  // parameters, and with no other column context to infer a type from,
  // Postgres defaulted `$2 >= $3` to a TEXT comparison — '100' >= '60' is
  // FALSE lexically (the ordering agreed with the real numeric comparison
  // for every value this repository's own earlier tests happened to use,
  // e.g. 75/10 against 60, which is exactly why it went undetected until a
  // real evaluation submission scored 100). Explicit `::numeric` casts
  // force the real numeric comparison Postgres would otherwise only infer
  // from a typed column, which `$2`/`$3` here are not.
  await client.query(
    `UPDATE agents
        SET baseline_evaluation_status = CASE
              WHEN $2::numeric >= $3::numeric THEN 'PASSED'
              WHEN baseline_evaluation_status <> 'PASSED' THEN 'FAILED'
              ELSE baseline_evaluation_status
            END
      WHERE id = $1`,
    [agentId, score, BASELINE_EVALUATION_PASSING_SCORE],
  );
}

/**
 * F-2012/T-2009: marks an Agent's baseline evaluation as "in progress" the
 * moment its first real submission is created — `NOT_STARTED` -> `PENDING`
 * only (never touches `PASSED`/`FAILED`, and never regresses a `PENDING`
 * Agent back to itself on a second submission, since the WHERE clause only
 * matches the `NOT_STARTED` starting state).
 */
export async function markBaselineEvaluationStarted(
  client: Queryable,
  agentId: string,
): Promise<void> {
  await client.query(
    `UPDATE agents SET baseline_evaluation_status = 'PENDING'
      WHERE id = $1 AND baseline_evaluation_status = 'NOT_STARTED'`,
    [agentId],
  );
}

export interface PendingReviewSubmissionRow {
  submissionId: string;
  agentId: string;
  evaluationTaskId: string;
  title: string;
  prompt: string;
  submittedContent: string;
  submittedAt: Date;
}

/**
 * F-2003/T-2002: the admin review queue — every `evaluation_submissions`
 * row whose task is `HUMAN_REQUIRED` and that has NOT yet been scored BY A
 * HUMAN (`NOT EXISTS` against `evaluation_results` scoped to `scored_by =
 * 'HUMAN'`, not a status column — a submission's "pending" state is
 * entirely derived from the absence of a HUMAN result, matching this
 * Task's own "评测提交与规则评分" design: nothing else ever needs a
 * separate submission-status field to track this).
 *
 * N4-lesson fix (T-2003): scoped to `scored_by = 'HUMAN'` specifically, not
 * "any result" — T-2003's AI-suggestion endpoint inserts an advisory
 * `scored_by = 'AI'` row for the SAME submission before a human ever
 * reviews it (design.md 决策 2's explicit "不允许 AI 评分直接成为终局分
 * 数"/"强制要求人工复核"). If this query treated ANY result as "done," a
 * submission with only an AI suggestion would silently vanish from the
 * queue and never receive the mandatory human review.
 */
export async function getPendingReviewSubmissions(
  client: Queryable,
): Promise<PendingReviewSubmissionRow[]> {
  const { rows } = await client.query<{
    id: string;
    agent_id: string;
    evaluation_task_id: string;
    title: string;
    prompt: string;
    submitted_content: string;
    submitted_at: Date;
  }>(
    `SELECT es.id, es.agent_id, es.evaluation_task_id, et.title, et.prompt,
            es.submitted_content, es.submitted_at
       FROM evaluation_submissions es
       JOIN evaluation_tasks et ON et.id = es.evaluation_task_id
      WHERE et.scoring_mode = 'HUMAN_REQUIRED'
        AND NOT EXISTS (
          SELECT 1 FROM evaluation_results er
           WHERE er.submission_id = es.id AND er.scored_by = 'HUMAN'
        )
      ORDER BY es.submitted_at ASC`,
  );
  return rows.map((row) => ({
    submissionId: row.id,
    agentId: row.agent_id,
    evaluationTaskId: row.evaluation_task_id,
    title: row.title,
    prompt: row.prompt,
    submittedContent: row.submitted_content,
    submittedAt: row.submitted_at,
  }));
}

export interface SubmissionRow {
  id: string;
  agentId: string;
  evaluationTaskId: string;
  scoringMode: "RULE_BASED" | "HUMAN_REQUIRED";
  hasResult: boolean;
}

/**
 * `admin-routes.ts`'s own pre-write check: is this submission a REAL
 * `HUMAN_REQUIRED` submission that hasn't already been scored (an admin
 * double-submitting a review, or reviewing a `RULE_BASED` submission by
 * guessing an id, are both real misuse the endpoint must reject before
 * writing a second/contradictory `evaluation_results` row).
 *
 * N4 real finding (P1, round 1): a plain check-then-insert (read this,
 * then separately `insertResult`) is a real TOCTOU race — two concurrent
 * reviews of the SAME submission can both observe `hasResult: false`
 * before either `INSERT` commits, both pass this check, and both create a
 * `HUMAN` result (the schema itself permits multiple results per
 * submission, since a LATER re-review via T-2004's appeal flow legitimately
 * adds a second result — so a blanket `UNIQUE(submission_id)` on
 * `evaluation_results` would be the wrong fix, it would break appeals).
 *
 * N4 real finding (P1, round 2): round 1's single `SELECT ... FOR UPDATE OF
 * es` combined the lock with the `has_result` check IN THE SAME STATEMENT.
 * Under READ COMMITTED, `FOR UPDATE`'s own re-check-after-blocking
 * mechanism (EvalPlanQual) only re-fetches the LOCKED row itself
 * (`evaluation_submissions`) — the correlated `EXISTS` subquery against
 * `evaluation_results` is a DIFFERENT table, not part of that re-check, and
 * can still be evaluated against the snapshot the statement started with,
 * from BEFORE the row it waited on became free. A second transaction that
 * had to wait could therefore still see `has_result: false` even though the
 * first transaction's result row was already committed. Fixed: `forUpdate:
 * true` now issues the lock as its OWN statement first (with no other table
 * involved), and only after that statement returns — which under READ
 * COMMITTED can only happen once the lock is actually free, i.e. after any
 * blocking transaction has committed or rolled back — does a SEPARATE,
 * brand-new statement check `has_result`. A fresh statement always takes a
 * fresh snapshot in READ COMMITTED, so it is guaranteed to see whatever the
 * previous transaction actually committed.
 *
 * N4-lesson fix (T-2003): `has_result` is scoped to `scored_by = 'HUMAN'`
 * specifically — same reasoning as `getPendingReviewSubmissions`'s own doc
 * comment. An AI-suggestion row must never make this function report a
 * submission as already reviewed.
 */
export async function getSubmissionForReview(
  client: Queryable,
  submissionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<SubmissionRow | null> {
  if (options.forUpdate) {
    await client.query(`SELECT id FROM evaluation_submissions WHERE id = $1 FOR UPDATE`, [
      submissionId,
    ]);
  }

  const { rows } = await client.query<{
    id: string;
    agent_id: string;
    evaluation_task_id: string;
    scoring_mode: "RULE_BASED" | "HUMAN_REQUIRED";
    has_result: boolean;
  }>(
    `SELECT es.id, es.agent_id, es.evaluation_task_id, et.scoring_mode,
            EXISTS (
              SELECT 1 FROM evaluation_results er
               WHERE er.submission_id = es.id AND er.scored_by = 'HUMAN'
            ) AS has_result
       FROM evaluation_submissions es
       JOIN evaluation_tasks et ON et.id = es.evaluation_task_id
      WHERE es.id = $1`,
    [submissionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    evaluationTaskId: row.evaluation_task_id,
    scoringMode: row.scoring_mode,
    hasResult: row.has_result,
  };
}

export interface SubmissionForAiSuggestionRow {
  id: string;
  scoringMode: "RULE_BASED" | "HUMAN_REQUIRED";
  prompt: string;
  submittedContent: string;
  hasHumanResult: boolean;
}

/**
 * F-2003/T-2003: the AI-suggestion endpoint's own read path — needs the
 * evaluation task's `prompt` (to build the scoring prompt) and the
 * submission's own content, plus the SAME `scored_by = 'HUMAN'`-scoped
 * `has_result` check `getSubmissionForReview` uses (an AI suggestion for a
 * submission a human already reviewed is a moot, no-op request the route
 * rejects rather than silently computing).
 *
 * N4 real finding (P2): the AI-suggestion endpoint calls a slow local model
 * (up to 30s) BETWEEN its first read of this data and writing the result —
 * an admin could complete a real human review during that window, and
 * writing the AI suggestion afterward without re-checking would violate
 * "already reviewed" (409) and leave a stale suggestion behind a real
 * terminal result. `options.forUpdate` applies the SAME two-statement
 * lock-then-fresh-read pattern `getSubmissionForReview` already established
 * (T-2002's own N4 round-2 lesson): a bare, single-table `FOR UPDATE`
 * first, then only after that returns does a separate fresh statement
 * check `has_human_result` — the route calls this a SECOND time, with
 * `forUpdate: true`, immediately before writing, inside the same
 * transaction as the write itself.
 */
export async function getSubmissionForAiSuggestion(
  client: Queryable,
  submissionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<SubmissionForAiSuggestionRow | null> {
  if (options.forUpdate) {
    await client.query(`SELECT id FROM evaluation_submissions WHERE id = $1 FOR UPDATE`, [
      submissionId,
    ]);
  }

  const { rows } = await client.query<{
    id: string;
    scoring_mode: "RULE_BASED" | "HUMAN_REQUIRED";
    prompt: string;
    submitted_content: string;
    has_human_result: boolean;
  }>(
    `SELECT es.id, et.scoring_mode, et.prompt, es.submitted_content,
            EXISTS (
              SELECT 1 FROM evaluation_results er
               WHERE er.submission_id = es.id AND er.scored_by = 'HUMAN'
            ) AS has_human_result
       FROM evaluation_submissions es
       JOIN evaluation_tasks et ON et.id = es.evaluation_task_id
      WHERE es.id = $1`,
    [submissionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    scoringMode: row.scoring_mode,
    prompt: row.prompt,
    submittedContent: row.submitted_content,
    hasHumanResult: row.has_human_result,
  };
}

export interface ResultOwnershipRow {
  submissionId: string;
  agentId: string;
}

/**
 * F-2004 (T-2004): resolves WHICH Agent a given `evaluation_results` row
 * belongs to (via its submission) — `routes.ts`'s appeal endpoint needs
 * this to run the SAME `requireOwnedAgent` ownership check F-503/F-504/
 * T-1605/T-2001 already established as the one real ownership rule
 * (CLAUDE.md 原则 6), rather than trusting a client-supplied `agentId`.
 */
export async function getAgentForResult(
  client: Queryable,
  evaluationResultId: string,
): Promise<ResultOwnershipRow | null> {
  const { rows } = await client.query<{ submission_id: string; agent_id: string }>(
    `SELECT es.id AS submission_id, es.agent_id
       FROM evaluation_results er
       JOIN evaluation_submissions es ON es.id = er.submission_id
      WHERE er.id = $1`,
    [evaluationResultId],
  );
  const row = rows[0];
  if (!row) return null;
  return { submissionId: row.submission_id, agentId: row.agent_id };
}

/** `pg` reports a unique-constraint violation as SQLSTATE `23505` — same
 * check `disputes/repository.ts`'s own `isUniqueViolation` uses, re-declared
 * here rather than imported for the same reason that module gives (a
 * two-line, well-understood check, not business knowledge worth coupling
 * two otherwise-independent modules over). This table's one relevant unique
 * constraint is `evaluation_appeals_one_pending_per_result`
 * (0031_create_evaluation_tables.sql, a partial index on
 * `evaluation_result_id WHERE status = 'PENDING'`), so any `23505` from
 * `insertAppeal` below is that constraint — a second appeal attempt against
 * a result that already has one open. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export interface InsertAppealInput {
  submissionId: string;
  evaluationResultId: string;
  agentOwnerAddress: string;
  reason: string;
}

/** Returns `null` (not a thrown error) when this result already has an open
 * `PENDING` appeal — `evaluation_appeals_one_pending_per_result`'s own
 * uniqueness violation, translated into a routine "already appealed"
 * outcome the caller (`routes.ts`) turns into a 409, matching this
 * codebase's `disputes/repository.ts` `insertDispute` precedent exactly. */
export async function insertAppeal(
  client: Queryable,
  input: InsertAppealInput,
): Promise<string | null> {
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO evaluation_appeals (submission_id, evaluation_result_id, agent_owner_address, reason)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.submissionId, input.evaluationResultId, input.agentOwnerAddress, input.reason],
    );
    const row = rows[0];
    if (!row) throw new Error("insertAppeal: INSERT ... RETURNING id returned no row");
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

export interface AppealRow {
  id: string;
  submissionId: string;
  agentId: string;
  evaluationResultId: string;
  status: "PENDING" | "RE_REVIEWED";
}

/**
 * `admin-routes.ts`'s own pre-write check for resolving an appeal — the
 * SAME two-statement lock-then-fresh-read pattern `getSubmissionForReview`
 * establishes (T-2002's own N4 round-2 finding): a bare `FOR UPDATE`
 * combined with a same-statement status check would have the identical
 * stale-snapshot race two concurrent "resolve this appeal" admins could
 * hit. Applied here from the start rather than repeating that same two-
 * round discovery.
 */
export async function getAppealForResolve(
  client: Queryable,
  appealId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AppealRow | null> {
  if (options.forUpdate) {
    await client.query(`SELECT id FROM evaluation_appeals WHERE id = $1 FOR UPDATE`, [appealId]);
  }

  const { rows } = await client.query<{
    id: string;
    submission_id: string;
    agent_id: string;
    evaluation_result_id: string;
    status: "PENDING" | "RE_REVIEWED";
  }>(
    `SELECT ea.id, ea.submission_id, es.agent_id, ea.evaluation_result_id, ea.status
       FROM evaluation_appeals ea
       JOIN evaluation_submissions es ON es.id = ea.submission_id
      WHERE ea.id = $1`,
    [appealId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    submissionId: row.submission_id,
    agentId: row.agent_id,
    evaluationResultId: row.evaluation_result_id,
    status: row.status,
  };
}

/**
 * The single writer for "resolving" an appeal (CLAUDE.md 原则 6) —
 * `status`/`resulting_evaluation_result_id` move together, matching the
 * migration's own `evaluation_appeals_result_matches_status` CHECK exactly
 * (never write one without the other).
 */
export async function resolveAppeal(
  client: Queryable,
  appealId: string,
  resultingEvaluationResultId: string,
): Promise<void> {
  await client.query(
    `UPDATE evaluation_appeals SET status = 'RE_REVIEWED', resulting_evaluation_result_id = $1
     WHERE id = $2`,
    [resultingEvaluationResultId, appealId],
  );
}
