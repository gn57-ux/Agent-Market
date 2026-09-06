import type { Pool, PoolClient } from "pg";
import type { Queryable } from "../../db/pool.js";
import { countActiveTasksByAgentIds } from "../tasks/repository.js";
import type { ReputationSignalsDigest, ReputationSignalsInput } from "./reputation-signals.js";

/**
 * Wire-format candidate snapshot POST /match (services/dispatch, T-704)
 * expects on its `candidates[]` array — field names match `matchCandidate`
 * (services/dispatch/internal/httpapi/match.go) exactly. `isNewcomer` is
 * deliberately absent: T-704's Go service computes newcomer status itself
 * from `completedTaskCount` (`domain.IsNewcomer`) and does not accept it as
 * an external input (capsule: "不要发送 isNewcomer 字段").
 *
 * `semanticSimilarity`/`reputationSignals` (Feature 13, T-1303) are
 * `undefined` for a "v0.1" request — `JSON.stringify` omits an `undefined`
 * property entirely, so the wire body simply doesn't carry the key, which
 * Go's decoder treats identically to an explicit absence (design.md's
 * "v0.1 请求中...恒为 0"/"v0.1 请求...不发送这个字段" contract). `matchTask`
 * (routes.ts) is the only place that ever sets them, and only for a
 * "v0.2" request.
 */
export interface CandidateSnapshot {
  agentId: string;
  walletAddress: string;
  status: string;
  category: string;
  skillTags: string[];
  level: string;
  maxConcurrentTasks: number;
  activeTaskCount: number;
  completedTaskCount: number;
  successCount: number;
  overdueCount: number;
  qualityScore: number | null;
  createdAt: string;
  isBanned: boolean;
  semanticSimilarity?: number;
  reputationSignals?: ReputationSignalsInput;
  /**
   * Feature 20 (agent-evaluation-appeal-antifraud), T-2009, design.md 决策
   * 3 — F-2012's basic-evaluation admission gate. A plain enum, never a
   * score (F-2011's boundary): Go's `eligibility.Filter` reads only
   * `baselineEvaluationStatus === "PASSED"` as one more in-memory AND
   * condition; it has no database connection of its own, so this field is
   * the only channel through which "cleared the basic evaluation gate"
   * reaches dispatch at all.
   */
  baselineEvaluationStatus: "NOT_STARTED" | "PENDING" | "PASSED" | "FAILED";
  /**
   * Feature 20 (agent-evaluation-appeal-antifraud), T-2008, 用户 2026-09-06
   * Q-2003 决策 — the independent risk-hold module's own admission signal,
   * DELIBERATELY a separate field from `baselineEvaluationStatus` above
   * (two orthogonal domain states, see `risk-hold/repository.ts`'s own doc
   * comment). Unlike `baselineEvaluationStatus`, this condition is always
   * enforced unconditionally (no config-flag gate): every Agent defaults
   * to `NONE` (safe), and the only way to reach `HELD` is a real confirmed
   * antifraud signal — there is no chicken-and-egg rollout problem here.
   */
  riskHoldStatus: "NONE" | "HELD";
}

interface CandidateAgentRow {
  id: string;
  owner_address: string;
  status: string;
  category: string;
  level: string;
  max_concurrent_tasks: number;
  completed_task_count: number;
  success_count: number;
  overdue_count: number;
  quality_score: number | null;
  created_at: Date;
  baseline_evaluation_status: "NOT_STARTED" | "PENDING" | "PASSED" | "FAILED";
  risk_hold_status: "NONE" | "HELD";
}

/**
 * T-705: assembles every `ACTIVE` Agent into the `CandidateSnapshot[]` the
 * Go dispatch service's `POST /match` consumes.
 *
 * The `status = 'ACTIVE'` filter below is a read optimization, not a
 * reimplementation of eligibility: `eligibility.Filter` (Go,
 * services/dispatch/internal/eligibility) independently checks the exact
 * same `status` field's exact same value again. Two checks of the same
 * real-world fact aren't two competing rules — one is "skip rows that can
 * never pass" (here), the other is the actual authority (Go). See the
 * T-705 capsule's reasoning for why this is the one narrow exception to
 * "eligibility logic lives only in Go."
 *
 * `AND review_status = 'ACTIVE'` (Codex review, T-1605 round 1 P1): `status`
 * (this Agent's own on/off market toggle) and `review_status` (Feature 16's
 * platform review lifecycle) are orthogonal columns (design.md 决策 3) — a
 * paid Agent awaiting review, rejected, or suspended by an admin still has
 * `status = 'ACTIVE'` (nothing in T-1604/T-1605 ever touches that column),
 * so without this second condition it would still be assembled as a
 * dispatch candidate and could be matched to real tasks, completely
 * bypassing the review gate this Feature exists to enforce. Go's
 * `eligibility.Filter` has no independent `review_status` check of its own
 * (unlike `status`, which it deliberately re-checks per this function's own
 * doc comment above) — this query is the ONLY place that enforces it, so it
 * cannot be treated as merely a read optimization the way the `status`
 * filter is.
 *
 * `AND risk_hold_status = 'NONE'` (N4 review, T-2008 round 1 P1): same
 * "not merely an optimization" reasoning as `review_status` above, for a
 * rolling-deployment reason specifically. `eligibility.Filter`'s
 * risk-hold condition (services/dispatch, Feature 20/T-2008) only exists
 * in the Go binary from this Task onward; during a rolling deploy where
 * this API instance runs against an OLDER dispatch instance, that older
 * Go service silently ignores the unknown `riskHoldStatus` JSON field and
 * would recommend a confirmed-antifraud-HELD Agent anyway — a real
 * "punishment recorded but not enforced" window. Filtering it here too
 * closes that window unconditionally, independent of which dispatch
 * version answers the request, with no config flag needed (the condition
 * is a pure narrowing of an already-safe default, unlike T-2009's
 * `baseline_evaluation_status` gate).
 *
 * Deliberately does NOT filter by `taskCategory` — category-compatibility
 * matching is eligibility's job alone (T-701 already fixed this as an exact
 * match rule); this function only fetches raw data and hands it over.
 */
export async function assembleCandidateSnapshots(
  client: Queryable,
  taskCategory: string,
): Promise<CandidateSnapshot[]> {
  // `taskCategory` is part of this function's fixed interface (T-705
  // capsule) but deliberately unused in the query below — see this
  // function's own doc comment for why category-compatibility filtering
  // must stay eligibility's (Go) job alone.
  void taskCategory;

  const { rows: agentRows } = await client.query<CandidateAgentRow>(
    `SELECT id, owner_address, status, category, level, max_concurrent_tasks,
            completed_task_count, success_count, overdue_count, quality_score, created_at,
            baseline_evaluation_status, risk_hold_status
     FROM agents
     WHERE status = 'ACTIVE' AND review_status = 'ACTIVE' AND risk_hold_status = 'NONE'`,
  );

  if (agentRows.length === 0) {
    return [];
  }

  const agentIds = agentRows.map((row) => row.id);

  const { rows: skillRows } = await client.query<{ agent_id: string; skill_tag: string }>(
    `SELECT agent_id, skill_tag FROM agent_skills WHERE agent_id = ANY($1)`,
    [agentIds],
  );
  const skillTagsByAgentId = new Map<string, string[]>();
  for (const row of skillRows) {
    const existing = skillTagsByAgentId.get(row.agent_id);
    if (existing) {
      existing.push(row.skill_tag);
    } else {
      skillTagsByAgentId.set(row.agent_id, [row.skill_tag]);
    }
  }

  // Batched: one query for every candidate's occupancy, not one query per
  // candidate — this function's own contract, mirrored by the batched
  // blocked_wallets lookup below.
  const activeTaskCountByAgentId = await countActiveTasksByAgentIds(client, agentIds);

  const walletAddresses = agentRows.map((row) => row.owner_address);
  const { rows: bannedRows } = await client.query<{ address: string }>(
    `SELECT address FROM blocked_wallets WHERE address = ANY($1)`,
    [walletAddresses],
  );
  const bannedWallets = new Set(bannedRows.map((row) => row.address));

  return agentRows.map((row) => ({
    agentId: row.id,
    walletAddress: row.owner_address,
    status: row.status,
    category: row.category,
    skillTags: skillTagsByAgentId.get(row.id) ?? [],
    level: row.level,
    maxConcurrentTasks: row.max_concurrent_tasks,
    activeTaskCount: activeTaskCountByAgentId.get(row.id) ?? 0,
    completedTaskCount: row.completed_task_count,
    successCount: row.success_count,
    overdueCount: row.overdue_count,
    qualityScore: row.quality_score,
    createdAt: row.created_at.toISOString(),
    isBanned: bannedWallets.has(row.owner_address),
    baselineEvaluationStatus: row.baseline_evaluation_status,
    riskHoldStatus: row.risk_hold_status,
  }));
}

/**
 * T-705: reads back just `tasks.required_agent_level` for `taskId`. A
 * dedicated one-column query rather than extending `tasks/repository.ts`'s
 * `TaskRow`/`getTaskById` (routes.ts already calls `getTaskById` for the
 * 404/ownership check and every other field `POST /match`'s request needs) —
 * broadening that shared type for this one dispatch-only field would ripple
 * into every other caller of `TaskRow` across the codebase for a value only
 * this route needs. Returns `null` only if `taskId` doesn't exist (routes.ts
 * never actually reaches this branch in practice, since it already confirmed
 * the task exists via `getTaskById` first).
 */
export async function getRequiredAgentLevel(
  client: Queryable,
  taskId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ required_agent_level: string }>(
    `SELECT required_agent_level FROM tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0]?.required_agent_level ?? null;
}

/**
 * F-1304/F-1305 (Feature 13, T-1303): reads `taskId`'s own embedding and,
 * from that SAME read, computes every requested candidate's cosine
 * similarity against it — one batched pgvector `<=>` query, never one
 * query per candidate. Returns `null` when the task has no embedding
 * (`matchTask`'s signal to fall back to "v0.1").
 *
 * Fused into one function on purpose (Codex review round 1, P2): an
 * earlier version checked "does a task_embeddings row exist" via one
 * query, then computed similarities via a SECOND, independent query that
 * re-referenced `task_embeddings` by `task_id` again. If `embed-on-save.
 * ts`'s regenerate-then-delete cycle (T-1302's round-2 fix: an update
 * deletes the task's existing embedding before attempting to regenerate
 * it) raced between those two queries, the second one would silently
 * return zero rows/an empty map instead of signaling "the embedding is
 * gone now" — the caller would then select "v0.2" and default every
 * candidate's similarity to 0, silently defeating F-1305's OR-branch for
 * that request instead of correctly falling back to "v0.1". Reading the
 * task's embedding ONCE as a real vector value and reusing that value
 * directly in the similarity query closes the gap: the "does it exist"
 * answer and the "compute with" value come from the exact same read, so
 * they can never disagree with each other.
 *
 * Agents without their OWN `agent_embeddings` row simply have no entry in
 * the returned map (the caller treats that as similarity 0 — "doesn't
 * clear the OR-branch threshold," not an error and not a reason to drop
 * that candidate, which can still qualify via exact category match).
 */
export async function getTaskSimilarityByAgentId(
  client: Queryable,
  taskId: string,
  agentIds: string[],
): Promise<Map<string, number> | null> {
  const { rows: taskRows } = await client.query<{ embedding: string }>(
    `SELECT embedding::text AS embedding FROM task_embeddings WHERE task_id = $1`,
    [taskId],
  );
  const taskEmbedding = taskRows[0]?.embedding;
  if (taskEmbedding === undefined) {
    return null;
  }

  const result = new Map<string, number>();
  if (agentIds.length === 0) {
    return result;
  }
  const { rows } = await client.query<{ agent_id: string; similarity: number }>(
    `SELECT agent_id, 1 - (embedding <=> $1::vector) AS similarity
     FROM agent_embeddings
     WHERE agent_id = ANY($2)`,
    [taskEmbedding, agentIds],
  );
  for (const row of rows) {
    result.set(row.agent_id, row.similarity);
  }
  return result;
}

/** One recommended slot, as returned by the Go dispatch service and about
 * to be persisted. `semanticSimilarity`/`reputationSignals` (Feature 13,
 * T-1307/F-1313) are `undefined` for a "v0.1" run — the columns they map
 * to (`recommendation_candidates.semantic_similarity`/`.reputation_signals`,
 * T-1300's migration) stay `NULL`, matching the migration's own
 * nullable-by-default design for exactly this case. `reputationSignals`
 * is the full `ReputationSignalsDigest` (value + sampleSize per signal),
 * not the flat wire shape sent to Go — this is the "输入特征摘要" AC-1307
 * requires be persisted for later replay, a strictly richer record than
 * what the match request itself carried. */
export interface RecommendationCandidateInput {
  agentId: string;
  rank: number;
  slotType: string;
  score: number;
  reasons: string[];
  semanticSimilarity?: number;
  reputationSignals?: ReputationSignalsDigest;
}

export interface InsertRecommendationRunInput {
  taskId: string;
  algorithmVersion: string;
  /** The full candidate pool sent to the Go service — NOT the number of
   * recommendations it returned (T-705 capsule: "candidate_count 用发给 Go 的
   *候选总数，不是返回的推荐数"). */
  candidateCount: number;
  /** SHA-256 (hex) of the canonically-ordered `MatchRequest` sent to the Go
   * service for this run (Feature 7 sync, T-709, P2) — see
   * `dispatch/input-digest.ts`. */
  inputDigest: string;
  candidates: RecommendationCandidateInput[];
}

/** Thrown by `insertRecommendationRunWithPermits` when, after acquiring the
 * task lock, the task still has an unexpired `OUTSTANDING` permit (Feature 7
 * sync, T-709 round 1, P1 — see `hasUnexpiredOutstandingPermits`'s doc
 * comment for why this check exists). Callers must fall back to returning
 * the still-current round's existing data idempotently. */
export class PermitsStillOutstandingError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} still has an unexpired OUTSTANDING permit`);
    this.name = "PermitsStillOutstandingError";
  }
}

/**
 * Returns whether `taskId` currently has any `acceptance_permits` row that
 * is both `status = 'OUTSTANDING'` AND not yet expired (Feature 7 sync,
 * T-709 round 1, P1). This is the actual security mechanism for "at most 3
 * candidates ever hold a cryptographically valid permit at a time" —
 * `POST /tasks/:taskId/match` and `POST /tasks/:taskId/acceptance-permits`
 * both refuse to start a NEW round (or issue a fresh set of permits) while
 * this returns true, so a new round can only ever be created once every
 * permit from the previous round has naturally expired. `status =
 * 'INVALIDATED'`/`'CONSUMED'` (T-806's own richer state machine) is NOT a
 * substitute for this check: marking a row INVALIDATED is bookkeeping for
 * this API's own responses, not something `TaskEscrow.acceptTask` ever
 * reads — an already-signed permit's cryptographic validity is governed
 * purely by its own `expiry` field until the chain itself rejects it.
 */
export async function hasUnexpiredOutstandingPermits(
  client: Queryable,
  taskId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM acceptance_permits
       WHERE task_id = $1 AND status = 'OUTSTANDING' AND expiry > EXTRACT(EPOCH FROM now())
     ) AS blocked`,
    [taskId],
  );
  return rows[0]?.blocked ?? false;
}

/** Thrown by `insertPermitsForRunIfAbsent` when, after acquiring the task
 * lock, `runId` turns out to no longer be the task's latest recommendation
 * run (Feature 7 sync, T-709 round 1, P1): `issuePermitsForTask` reads
 * `runId` OUTSIDE any transaction; if a concurrent `POST /tasks/:taskId/match`
 * call commits a newer run in the gap between that read and this function
 * acquiring the lock, inserting permits for the now-stale run would leave
 * both the old and new run's permits briefly OUTSTANDING. The caller must
 * re-read the latest run and its candidates and retry. */
export class StaleRecommendationRunError extends Error {
  constructor(taskId: string, staleRunId: string) {
    super(`recommendation run ${staleRunId} for task ${taskId} is no longer the latest run`);
    this.name = "StaleRecommendationRunError";
  }
}

/**
 * Reads the id of the most recent `recommendation_run` for `taskId` — same
 * "latest run" ordering `getLatestRecommendationCandidates` uses
 * (`requested_at DESC, sequence_no DESC`). `issuePermitsForTask` needs just
 * the id (to look up outstanding permits and detect staleness), not the
 * full candidate join that function returns.
 */
export async function getLatestRecommendationRunId(
  client: Queryable,
  taskId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM recommendation_runs
     WHERE task_id = $1
     ORDER BY requested_at DESC, sequence_no DESC
     LIMIT 1`,
    [taskId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Reads every currently-`OUTSTANDING` `acceptance_permits` row for one
 * recommendation run (Feature 7 sync, T-709) — the read
 * `issuePermitsForTask`'s idempotent-reissue check uses. Returns `[]` if the
 * run has never had permits issued, or all of them have since been
 * invalidated by a newer run superseding this one. Returns the SAME
 * `SignedAcceptancePermit` shape `signPermitsForCandidates` (routes.ts)
 * produces, so routes.ts can treat "freshly signed" and "read back from an
 * existing run" permits identically.
 */
export async function getOutstandingPermitsForRun(
  client: Queryable,
  runId: string,
): Promise<SignedAcceptancePermit[]> {
  const { rows } = await client.query<{
    agent_id: string;
    accepting_address: string;
    nonce: string;
    expiry: string;
    chain_id: number;
    verifying_contract: string;
    signature: string;
  }>(
    `SELECT agent_id, accepting_address, nonce, expiry, chain_id, verifying_contract, signature
     FROM acceptance_permits
     WHERE run_id = $1 AND status = 'OUTSTANDING'
     ORDER BY created_at ASC`,
    [runId],
  );

  return rows.map((row) => ({
    agentId: row.agent_id,
    agentWalletAddress: row.accepting_address,
    nonce: row.nonce,
    // BIGINT comes back as a string from `pg` — same conversion
    // `getPermitForAgent` already performs below.
    expiry: Number(row.expiry),
    chainId: row.chain_id,
    verifyingContract: row.verifying_contract,
    signature: row.signature,
  }));
}

/** One already-signed `AcceptancePermit` ready to persist — the shape both
 * `insertRecommendationRunWithPermits` (auto-issuance right after `/match`)
 * and `insertPermitsForRunIfAbsent` (`POST /tasks/:taskId/acceptance-permits`
 * manual re-issuance) accept. Signing (`issueAcceptancePermit`,
 * dispatch/permit.service.ts) happens entirely in memory, BEFORE either of
 * these functions is ever called (T-806 capsule: "先在内存里完成全部签名，再
 * 一个事务里全部写入") — signing is pure CPU/ECDSA work with no reason to
 * hold a database connection or transaction open for its duration.
 * `agentWalletAddress` becomes each inserted row's `accepting_address`
 * snapshot (0008_create_acceptance_permits.sql's header comment). */
export interface SignedAcceptancePermit {
  agentId: string;
  agentWalletAddress: string;
  nonce: string;
  expiry: number;
  chainId: number;
  verifyingContract: string;
  signature: string;
}

export interface InsertRecommendationRunWithPermitsInput extends InsertRecommendationRunInput {
  /** One already-signed permit per candidate in `candidates` above — every
   * recommended candidate gets its own permit bound to its own `agentId`
   * (T-806 human N6 BLOCK fix: this replaces T-803 round 2's rejected
   * "dedupe by wallet, skip lower-ranked candidates" design — see this
   * file's own header note below `insertAcceptancePermit` for the full
   * reasoning). Not required to be 1:1 with `candidates` by this function
   * itself (callers decide), but `matchTask`/`issuePermitsForTask`
   * (routes.ts) always pass exactly one permit per candidate. */
  permits: SignedAcceptancePermit[];
}

/**
 * Persists one `POST /tasks/:taskId/match` run — the `recommendation_runs`
 * row, one `recommendation_candidates` row per recommended slot, AND one
 * `acceptance_permits` row per already-signed permit — atomically in a
 * SINGLE transaction (T-806, human N6 BLOCK fix, user's item #1: "Permit
 * 原子签发"). Any failure at any point (including a single candidate's
 * permit insert failing an FK/UNIQUE constraint) ROLLBACKs the entire
 * transaction, leaving zero rows in all three tables — a partial write
 * (run persisted, some candidates/permits missing) would silently corrupt
 * "this run recommended exactly these slots, each with a usable permit" as
 * a single unit, the same "all or nothing" reasoning `insertRecommendationRun`
 * (this function's now-removed T-705 predecessor) already applied to just
 * run+candidates, extended to cover permits too.
 *
 * Opens with `SELECT status FROM tasks WHERE id = $1 FOR UPDATE` (T-806,
 * user's item #1's last sentence: serializing concurrent `/match` calls) —
 * this is NOT a mechanism for rejecting a legitimate repeated `/match` call
 * in general; it only ensures that two concurrent calls for the SAME task
 * each complete their own write as an uninterrupted unit. The lock is
 * released when this transaction COMMITs/ROLLBACKs.
 *
 * Feature 7 sync (T-709 round 1, P1) changes what "a legitimate repeated
 * `/match` call" means: immediately after the OPEN re-check, this also
 * re-checks `hasUnexpiredOutstandingPermits` under the same lock — a NEW
 * round can only be created once every permit from the CURRENT round has
 * naturally expired, throwing `PermitsStillOutstandingError` otherwise. This
 * is the actual enforcement mechanism for "at most 3 candidates ever hold a
 * cryptographically valid permit at a time" (see that function's own doc
 * comment) — the `INVALIDATED` status this function also sets on the
 * (by then guaranteed-expired) previous round's rows below is bookkeeping
 * for API responses, not a security control.
 */
export async function insertRecommendationRunWithPermits(
  pool: Pool,
  input: InsertRecommendationRunWithPermitsInput,
): Promise<{ runId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Race-free OPEN check while holding the lock (Codex review, T-806
    // round 2, P2): the row lock alone only serializes concurrent writers
    // against EACH OTHER — it does nothing to stop this transaction from
    // happily persisting a new run + OUTSTANDING permits for a task that
    // has already left OPEN (e.g. `/match` invoked for an already-ACCEPTED
    // or cancelled task, or a status change that lands in the gap between
    // matchTask's own initial read and this transaction actually starting).
    // Same `TaskNotOpenForPermitsError`/status column as
    // `insertPermitsForRunIfAbsent`'s identical check — one shared error
    // type for "the lock revealed this task is no longer OPEN," not two.
    const { rows: taskRows } = await client.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1 FOR UPDATE`,
      [input.taskId],
    );
    if (taskRows[0]?.status !== "OPEN") {
      throw new TaskNotOpenForPermitsError(input.taskId);
    }

    // Feature 7 sync (T-709 round 1, P1) — see this function's own doc
    // comment above.
    if (await hasUnexpiredOutstandingPermits(client, input.taskId)) {
      throw new PermitsStillOutstandingError(input.taskId);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.taskId, input.algorithmVersion, input.candidateCount, input.inputDigest],
    );
    const runId = rows[0]?.id;
    if (!runId) {
      throw new Error("insertRecommendationRunWithPermits: INSERT ... RETURNING produced no row");
    }

    for (const candidate of input.candidates) {
      await insertRecommendationCandidate(client, runId, candidate);
    }

    // Feature 7 sync (T-709): marks every OTHER run's still-OUTSTANDING
    // permits for this task INVALIDATED. By the time this line runs, the
    // hasUnexpiredOutstandingPermits check above already guarantees any
    // such rows are expired — this is cleanup for API responses/idempotent
    // reads, not what actually makes the old round unusable (its own
    // expiry does that).
    await client.query(
      `UPDATE acceptance_permits
       SET status = 'INVALIDATED', consumed_at = now()
       WHERE task_id = $1 AND run_id <> $2 AND status = 'OUTSTANDING'`,
      [input.taskId, runId],
    );

    for (const permit of input.permits) {
      await insertAcceptancePermit(client, {
        taskId: input.taskId,
        runId,
        agentId: permit.agentId,
        acceptingAddress: permit.agentWalletAddress,
        nonce: permit.nonce,
        expiry: permit.expiry,
        chainId: permit.chainId,
        verifyingContract: permit.verifyingContract,
        signature: permit.signature,
      });
    }

    await client.query("COMMIT");
    return { runId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Thrown when the task-row lock reveals the task has left `OPEN` between
 * the caller's initial read and this transaction's write (Codex review,
 * T-806 round 1, P2) — a bare pre-check in `issuePermitsForTask` before
 * opening this transaction cannot close that race by itself, since the
 * task's status can still change in the gap between that check and this
 * function actually starting; only re-checking while holding `FOR UPDATE`
 * on the task row is race-free. */
export class TaskNotOpenForPermitsError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} is no longer OPEN`);
    this.name = "TaskNotOpenForPermitsError";
  }
}

/**
 * `POST /tasks/:taskId/acceptance-permits`'s (manual re-issuance) atomic
 * write for one specific recommendation run — only `acceptance_permits`
 * rows, since the run/candidates it re-issues permits for already exist
 * (T-806 capsule: this endpoint's counterpart to
 * `insertRecommendationRunWithPermits` above, for the case where no new run
 * is being created). Same "sign everything in memory first, write
 * everything in one transaction" discipline: any single insert failing
 * ROLLBACKs the whole batch, leaving zero new permit rows.
 *
 * Feature 7 sync (T-709 round 1, P1) turned this into a true idempotent-
 * reissue-if-absent operation, replacing the old unconditional-insert
 * `insertPermitsAtomically`: `issuePermitsForTask` (routes.ts) calls this
 * only after its own outside-the-transaction reads found `runId` to be the
 * latest run with zero OUTSTANDING permits; this function re-does BOTH
 * checks INSIDE the transaction, after acquiring the task lock:
 *
 *   1. `runId` must still be the task's latest run — a concurrent
 *      `POST /tasks/:taskId/match` could have committed a newer run in the
 *      gap between the caller's read and this function acquiring the lock.
 *      Throws `StaleRecommendationRunError` rather than silently persisting
 *      permits for a superseded run; the caller must re-fetch and retry.
 *   2. `runId` must still have zero OUTSTANDING permits — two genuinely
 *      concurrent `POST /tasks/:taskId/acceptance-permits` calls for the
 *      same still-latest run can't both win the outside check and both
 *      insert a full duplicate set; the loser sees the winner's freshly-
 *      committed permits and returns those instead.
 *
 * Returns the run's OUTSTANDING permits either way (freshly inserted, or
 * pre-existing from the winning concurrent caller) — callers never need to
 * distinguish which happened.
 */
export async function insertPermitsForRunIfAbsent(
  pool: Pool,
  input: { runId: string; taskId: string; permits: SignedAcceptancePermit[] },
): Promise<SignedAcceptancePermit[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Race-free OPEN check (Codex review, T-806 round 1, P2): locks the task
    // row for the duration of this transaction so no concurrent
    // OPEN→(anything else) transition can commit in between this check and
    // the permit inserts below — see `TaskNotOpenForPermitsError`'s doc
    // comment for why a pre-check outside this transaction isn't enough.
    const { rows: taskRows } = await client.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1 FOR UPDATE`,
      [input.taskId],
    );
    if (taskRows[0]?.status !== "OPEN") {
      throw new TaskNotOpenForPermitsError(input.taskId);
    }

    // Feature 7 sync (T-709 round 1, P1) — see this function's own doc
    // comment above, check 1.
    const latestRunId = await getLatestRecommendationRunId(client, input.taskId);
    if (latestRunId !== input.runId) {
      throw new StaleRecommendationRunError(input.taskId, input.runId);
    }

    // Feature 7 sync (T-709 round 1, P1) — see this function's own doc
    // comment above, check 2.
    const existing = await getOutstandingPermitsForRun(client, input.runId);
    if (existing.length > 0) {
      await client.query("COMMIT");
      return existing;
    }

    for (const permit of input.permits) {
      await insertAcceptancePermit(client, {
        taskId: input.taskId,
        runId: input.runId,
        agentId: permit.agentId,
        acceptingAddress: permit.agentWalletAddress,
        nonce: permit.nonce,
        expiry: permit.expiry,
        chainId: permit.chainId,
        verifyingContract: permit.verifyingContract,
        signature: permit.signature,
      });
    }
    const inserted = await getOutstandingPermitsForRun(client, input.runId);

    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * One recommended candidate as read back from the most recent
 * `recommendation_run` for a task — the shape both
 * `GET /tasks/:taskId/recommendations` and
 * `POST /tasks/:taskId/acceptance-permits` (T-706) consume from the single
 * query below. `agentWalletAddress` is included here (joined from
 * `agents.owner_address`) even though the `GET /recommendations` response
 * shape (design.md) doesn't expose it — routes.ts drops it for that route
 * and uses it for the acceptance-permits route, which needs the candidate's
 * wallet address to sign the `AcceptancePermit.agent` field.
 */
export interface LatestRecommendationCandidate {
  agentId: string;
  agentWalletAddress: string;
  rank: number;
  slotType: string;
  score: number;
  reasons: string[];
}

/**
 * `getLatestRecommendationCandidates`'s return shape (Feature 13, T-1303
 * widened this from a bare array). `algorithmVersion` is the run's own
 * PERSISTED value — never recomputed fresh — because a caller reading this
 * back (`matchTask`'s two early-return paths, routes.ts) must report
 * whatever algorithm that EXISTING run actually used, which can disagree
 * with what a fresh decision would produce right now (e.g. the task's
 * embedding was generated or deleted after that run was created).
 */
export interface LatestRecommendationRunCandidates {
  /** `null` only when no run exists yet for this task (F-709's legitimate
   * "never matched" state) — distinct from a real run that recommended
   * zero candidates, where this is still that run's true algorithm_version
   * and `candidates` is simply `[]`. */
  algorithmVersion: string | null;
  candidates: LatestRecommendationCandidate[];
}

/**
 * Reads back the most recent `recommendation_run`'s algorithm version and
 * candidates for `taskId`, candidates ordered by rank ascending (T-706
 * capsule: "查询最新一次 recommendation_run 的候选列表"). Both T-706 routes
 * need exactly this — "the latest run's full candidate list" — so it's the
 * one query both call rather than each assembling its own join.
 *
 * Returns `{ algorithmVersion: null, candidates: [] }` when no run exists
 * yet for this task (nobody has called `POST /tasks/:taskId/match`) — a
 * legitimate state (F-709), not an error; callers decide what that means
 * for their own response (200 empty array for GET /recommendations, 400
 * for POST /acceptance-permits).
 *
 * Resolves the latest run's id ONCE (via `getLatestRecommendationRunId`)
 * and scopes both the `algorithm_version` lookup and the candidates query
 * to that exact, fixed `run_id` (Codex review round 1, P2: an earlier
 * version re-evaluated "the latest run for taskId" independently in TWO
 * separate queries — if a concurrent `POST /match` committed a newer run
 * in the gap between them, `algorithmVersion` could come back from the
 * OLDER run while `candidates` came from the NEWER one, reporting a
 * version/count pair that never actually coexisted). A `recommendation_
 * runs`/`recommendation_candidates` row is never updated after insert
 * (same immutability this file's other doc comments already establish),
 * so once a concrete `run_id` is pinned down, both follow-up reads are
 * safe from any further concurrent write — there is no remaining window
 * for them to disagree.
 *
 * `sequence_no` (a `BIGSERIAL`) is `getLatestRecommendationRunId`'s own
 * deterministic tiebreaker: `requested_at` alone can tie when two
 * `POST /match` calls for the same task land in the same DB-clock instant,
 * which would otherwise make "the latest run" pick either row
 * nondeterministically (Codex review, T-706 round 1, P2).
 *
 * `rc.score` is `NUMERIC` in Postgres, which `pg` returns as a string (no
 * custom type parser is registered in this codebase) — explicitly
 * `Number(...)`-converted here, the same pattern `agents/repository.ts`
 * uses for its own `NUMERIC`-derived aggregate.
 */
export async function getLatestRecommendationCandidates(
  client: Queryable,
  taskId: string,
): Promise<LatestRecommendationRunCandidates> {
  const runId = await getLatestRecommendationRunId(client, taskId);
  if (runId === null) {
    return { algorithmVersion: null, candidates: [] };
  }

  const { rows: runRows } = await client.query<{ algorithm_version: string }>(
    `SELECT algorithm_version FROM recommendation_runs WHERE id = $1`,
    [runId],
  );
  const algorithmVersion = runRows[0]?.algorithm_version ?? null;

  const { rows } = await client.query<{
    agent_id: string;
    owner_address: string;
    rank: number;
    slot_type: string;
    score: string;
    reasons: string[];
  }>(
    `SELECT rc.agent_id, a.owner_address, rc.rank, rc.slot_type, rc.score, rc.reasons
     FROM recommendation_candidates rc
     JOIN agents a ON a.id = rc.agent_id
     WHERE rc.run_id = $1
     ORDER BY rc.rank ASC`,
    [runId],
  );

  return {
    algorithmVersion,
    candidates: rows.map((row) => ({
      agentId: row.agent_id,
      agentWalletAddress: row.owner_address,
      rank: row.rank,
      slotType: row.slot_type,
      score: Number(row.score),
      reasons: row.reasons,
    })),
  };
}

/**
 * Reads back one SPECIFIC recommendation run's candidates by `runId` —
 * deliberately NOT "the latest run for this task" (human review finding,
 * T-806 post-cap): `issuePermitsForTask` (routes.ts) must sign permits for
 * the exact same run whose id it already committed to, not re-resolve
 * "latest" a second time after already reading candidates once. A
 * `recommendation_candidates` row is immutable and permanently tied to the
 * `run_id` it was inserted under (nothing ever updates or reassigns it), so
 * scoping this query by an explicit `runId` — established once by the
 * caller via `getLatestRecommendationRunId` — cannot be affected by a
 * concurrent `/match` call creating a newer run afterward; that new run's
 * candidates live under ITS OWN `run_id`, never retroactively attached to
 * this one. Returns `[]` if `runId` has no candidate rows (defensive; not
 * expected to happen for a run that was actually returned by
 * `getLatestRecommendationRunId`, since a run is only ever created together
 * with its candidates in the same transaction).
 */
export async function getRecommendationCandidatesForRun(
  client: Queryable,
  runId: string,
): Promise<LatestRecommendationCandidate[]> {
  const { rows } = await client.query<{
    agent_id: string;
    owner_address: string;
    rank: number;
    slot_type: string;
    score: string;
    reasons: string[];
  }>(
    `SELECT rc.agent_id, a.owner_address, rc.rank, rc.slot_type, rc.score, rc.reasons
     FROM recommendation_candidates rc
     JOIN agents a ON a.id = rc.agent_id
     WHERE rc.run_id = $1
     ORDER BY rc.rank ASC`,
    [runId],
  );

  return rows.map((row) => ({
    agentId: row.agent_id,
    agentWalletAddress: row.owner_address,
    rank: row.rank,
    slotType: row.slot_type,
    score: Number(row.score),
    reasons: row.reasons,
  }));
}

async function insertRecommendationCandidate(
  client: PoolClient,
  runId: string,
  candidate: RecommendationCandidateInput,
): Promise<void> {
  await client.query(
    `INSERT INTO recommendation_candidates
       (run_id, agent_id, rank, slot_type, score, reasons, semantic_similarity, reputation_signals)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      runId,
      candidate.agentId,
      candidate.rank,
      candidate.slotType,
      candidate.score,
      JSON.stringify(candidate.reasons),
      candidate.semanticSimilarity ?? null,
      candidate.reputationSignals ? JSON.stringify(candidate.reputationSignals) : null,
    ],
  );
}

// ---------------------------------------------------------------------
// T-801 (Feature 8): `acceptance_permits` persistence. Feature 7's
// `issuePermitsForTask` (routes.ts) deliberately left this table
// unbuilt/unwritten ("Feature 8 的 job once it needs one") — this section
// is that table finally existing, plus the read/write operations Feature
// 8's `TaskAccepted` event-sync backfill needs.
//
// T-806 (human N6 BLOCK fix, round after T-803/T-805): T-803 round 2's
// wallet-dedup "fix" for the same-wallet-multiple-Agents ambiguity was
// rejected by the human reviewer — every recommended candidate now gets its
// own permit, and attribution is resolved by decoding the EXACT nonce the
// on-chain transaction's own calldata used (see acceptance-tx-verifier.ts's
// `decodeAcceptTaskCalldata`), not by any wallet-level dedup or ordering
// guess. `resolveAcceptingAgentId` below is the read half of that design;
// `insertRecommendationRunWithPermits`/`insertPermitsForRunIfAbsent` above
// are the write half.
// ---------------------------------------------------------------------

export interface InsertAcceptancePermitInput {
  taskId: string;
  /** The recommendation run this permit was issued for (Feature 7 sync,
   * T-709) — see 0008_create_acceptance_permits.sql's `run_id` column
   * comment. */
  runId: string;
  agentId: string;
  /** The candidate wallet address AT ISSUANCE TIME — see
   * 0008_create_acceptance_permits.sql's header comment for why this is
   * stored as its own column rather than re-derived from
   * `agents.owner_address` at read time. Normalized to lowercase before
   * storage (this column's own CHECK constraint requires it). */
  acceptingAddress: string;
  /** Decimal-string `uint256` — see 0008_create_acceptance_permits.sql's
   * header comment for why this is TEXT, never a JS `number`. */
  nonce: string;
  /** Unix seconds. */
  expiry: number;
  chainId: number;
  /** Normalized to lowercase before storage (this column's own CHECK
   * constraint requires it) — the signature itself, computed over the
   * un-normalized value `permit.service.ts` actually signed with, is
   * unaffected by this display/audit-only normalization. */
  verifyingContract: string;
  signature: string;
}

/**
 * Persists one issued `AcceptancePermit` row, `status` defaulting to
 * `'OUTSTANDING'` (the column's own DB default). Always called from inside
 * one of the two atomic-batch functions above
 * (`insertRecommendationRunWithPermits`/`insertPermitsForRunIfAbsent`) —
 * never on its own with a bare `Pool`, since every permit issuance must be
 * part of an all-or-nothing batch write (T-806 capsule's item #1). Never
 * re-uses/dedupes an existing row: each signing call mints a fresh nonce
 * (`permit.service.ts`'s `generateNonce`), so each call's rows are new,
 * independent grants — matching `UNIQUE (task_id, agent_id, nonce)`'s own
 * "same issuance never inserted twice, but the same agent can hold several
 * rows across rounds" design.
 */
export async function insertAcceptancePermit(
  client: Queryable,
  input: InsertAcceptancePermitInput,
): Promise<void> {
  await client.query(
    `INSERT INTO acceptance_permits
       (task_id, run_id, agent_id, accepting_address, nonce, expiry, chain_id, verifying_contract, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.taskId,
      input.runId,
      input.agentId,
      input.acceptingAddress.toLowerCase(),
      input.nonce,
      input.expiry,
      input.chainId,
      input.verifyingContract.toLowerCase(),
      input.signature,
    ],
  );
}

/**
 * Resolves EXACTLY which `agents.id` accepted a task, given the wallet
 * address recovered from an independently-verified on-chain `TaskAccepted`
 * event AND the exact `nonce` recovered from that same transaction's own
 * calldata (`acceptance-tx-verifier.ts`'s `decodeAcceptTaskCalldata`) —
 * T-806, human N6 BLOCK fix, user's items #1/#2.
 *
 * `(task_id, accepting_address, nonce)` together identify AT MOST one
 * `acceptance_permits` row by construction: `nonce` is a fresh high-entropy
 * random `uint256` minted per issuance (`permit.service.ts`'s
 * `generateNonce`), so two different candidates' rows — even for the same
 * wallet, even across different `/match` rounds — never collide on it in
 * practice, and `UNIQUE (task_id, agent_id, nonce)` plus this query's own
 * `status = 'OUTSTANDING'` scoping means there is no ambiguity left to
 * resolve: whichever row this exact triple names IS the permit that was
 * actually used, full stop.
 *
 * This deliberately does NOT fall back to guessing via `owner_address`
 * alone, an ordering tiebreak, or "pick the oldest registered Agent under
 * this wallet" — the wallet-level dedup this function's T-803/T-805
 * predecessor relied on for that fallback to ever be "safe" no longer
 * exists (T-806 capsule: "不再有任何 ORDER BY ... LIMIT 1 的排序猜测，也不再有
 * 查不到 permit 就退回随便一个 Agent 的 fallback 分支"). Not finding a matching
 * row — for ANY reason, including a permit history that was somehow
 * cleared — returns `null`; `verifyAcceptance` (tasks/service.ts) surfaces
 * that as a `chain_error` and does not record an acceptance, rather than
 * crediting a possibly-wrong Agent (CLAUDE.md 原则 8: 尽可能让非法状态无法
 * 表示 — refuse to guess rather than silently misattribute real financial
 * state).
 */
export async function resolveAcceptingAgentId(
  client: Queryable,
  taskId: string,
  acceptingAddress: string,
  nonce: string,
): Promise<string | null> {
  const normalizedAddress = acceptingAddress.toLowerCase();
  const { rows } = await client.query<{ agent_id: string }>(
    `SELECT agent_id
     FROM acceptance_permits
     WHERE task_id = $1 AND accepting_address = $2 AND nonce = $3 AND status = 'OUTSTANDING'`,
    [taskId, normalizedAddress, nonce],
  );
  return rows[0]?.agent_id ?? null;
}

/** `GET /tasks/:taskId/agents/:agentId/acceptance-permit`'s (T-806,
 * replacing T-803's `GET /tasks/:taskId/my-acceptance-permit`) response
 * shape — an outstanding, unexpired permit for one specific candidate
 * `agentId` that the caller's own session address owns. `nonce` stays the
 * decimal-string `uint256` (see `InsertAcceptancePermitInput.nonce`'s doc
 * comment). */
export interface PermitForAgent {
  nonce: string;
  expiry: number;
  chainId: number;
  verifyingContract: string;
  signature: string;
  acceptingAddress: string;
}

/**
 * T-806's per-candidate "read back my own outstanding permit" query,
 * replacing T-803's wallet-only `getUnconsumedPermitForWallet` now that a
 * single wallet can hold outstanding permits for more than one candidate
 * Agent on the same task — the caller must now say WHICH candidate
 * (`agentId`) it means, not just "my wallet's permit" (there may be
 * several).
 *
 * `a.owner_address = $3` (the session address must actually own this
 * `agentId` — the authorization check) AND `ap.accepting_address = $3`
 * (this permit row was actually signed for this same address — a second,
 * defensive confirmation; the two should always agree by construction, but
 * checking both explicitly costs nothing and catches any future drift
 * between "who owns this Agent now" and "who this permit was issued to"
 * without weakening either check, per the T-806 capsule's explicit design).
 *
 * `ap.status = 'OUTSTANDING'` + `ap.expiry > extract(epoch from now())` +
 * `t.status = 'OPEN'` together are AC-804's full "usable" judgment (same
 * reasoning `getUnconsumedPermitForWallet` already established — a task
 * that left OPEN by any path, or a permit that already got INVALIDATED by
 * a different candidate's acceptance, must not read back as usable).
 *
 * Returns `null` for every failure reason uniformly (not a candidate,
 * wrong owner, task not OPEN, permit consumed/invalidated/expired) — the
 * route turns this into a single 404 with no distinguishing detail
 * (T-806 capsule: "不区分具体原因", same T-605/T-705 precedent as every
 * other ownership-scoped lookup in this codebase).
 */
export async function getPermitForAgent(
  client: Queryable,
  taskId: string,
  agentId: string,
  sessionAddress: string,
): Promise<PermitForAgent | null> {
  const normalizedAddress = sessionAddress.toLowerCase();
  const { rows } = await client.query<{
    nonce: string;
    expiry: string;
    chain_id: number;
    verifying_contract: string;
    signature: string;
    accepting_address: string;
  }>(
    `SELECT ap.nonce, ap.expiry, ap.chain_id, ap.verifying_contract, ap.signature, ap.accepting_address
     FROM acceptance_permits ap
     JOIN agents a ON a.id = ap.agent_id
     JOIN tasks t ON t.id = ap.task_id
     WHERE ap.task_id = $1
       AND ap.agent_id = $2
       AND a.owner_address = $3
       AND ap.accepting_address = $3
       AND ap.status = 'OUTSTANDING'
       AND ap.expiry > extract(epoch from now())
       AND t.status = 'OPEN'
     ORDER BY ap.created_at DESC
     LIMIT 1`,
    [taskId, agentId, normalizedAddress],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    nonce: row.nonce,
    // BIGINT comes back as a string from `pg` (no custom type parser
    // registered) — `Number(...)` is safe here, matching `rc.score`'s
    // identical `NUMERIC`-returned-as-string conversion above; Unix-second
    // expiries are always well inside `Number.MAX_SAFE_INTEGER`.
    expiry: Number(row.expiry),
    chainId: row.chain_id,
    verifyingContract: row.verifying_contract,
    signature: row.signature,
    acceptingAddress: row.accepting_address,
  };
}

/**
 * Marks the ONE `acceptance_permits` row precisely identified by
 * `(taskId, agentId, nonce)` as `CONSUMED` (T-806, replacing T-801's
 * "mark every outstanding row for this agent consumed" behavior, which was
 * only ever correct because a single agent could have at most one
 * outstanding row under the old wallet-dedup design). Now that an agent can
 * legitimately hold several historical permit rows (across `/match`
 * rounds), only the exact row the on-chain transaction's own calldata
 * named — via `resolveAcceptingAgentId`'s nonce match — should become
 * CONSUMED; every one of this agent's (and every other candidate's) OTHER
 * outstanding rows for this task must instead become INVALIDATED
 * (`invalidateOtherOutstandingPermits`, called alongside this from
 * `tasks/service.ts`'s `verifyAcceptance`, both inside the same
 * transaction) — they were never used, but they are no longer usable
 * either, since the task has left `OPEN`.
 *
 * `WHERE ... AND status = 'OUTSTANDING'` guards against double-consuming an
 * already-CONSUMED row (defensive; `verifyAcceptance`'s own idempotent-
 * replay handling means this should never actually be reached twice for
 * the same row in practice).
 */
export async function consumeAcceptancePermits(
  client: Queryable,
  taskId: string,
  agentId: string,
  nonce: string,
  txHash: string,
): Promise<void> {
  await client.query(
    `UPDATE acceptance_permits
     SET status = 'CONSUMED', consumed_at = now(), consumed_tx_hash = $3
     WHERE task_id = $1 AND agent_id = $2 AND nonce = $4 AND status = 'OUTSTANDING'`,
    [taskId, agentId, txHash, nonce],
  );
}

/**
 * Marks every OTHER still-`OUTSTANDING` `acceptance_permits` row for
 * `taskId` (i.e. every candidate's permit except `excludeAgentId`'s winning
 * one, AND that same winning agent's own OTHER outstanding rows from
 * earlier rounds, if any) as `INVALIDATED` (T-806, user's item #5: "Permit
 * 失效：一旦任务被接单，所有其他 outstanding permits ... 都必须变成
 * INVALIDATED"). `consumed_tx_hash` is deliberately left `NULL` for these
 * rows — they were never consumed BY a transaction, they simply stopped
 * being usable once this task left `OPEN` (see
 * 0008_create_acceptance_permits.sql's column comment).
 *
 * Always called alongside `consumeAcceptancePermits` inside the same
 * `transitionTaskStatus` transaction (`tasks/service.ts`'s
 * `verifyAcceptance`) — "task status is ACCEPTED" and "every non-winning
 * permit for it is INVALIDATED" must never be observably out of sync.
 */
export async function invalidateOtherOutstandingPermits(
  client: Queryable,
  taskId: string,
  excludeAgentId: string,
  excludeNonce: string,
): Promise<void> {
  // Excludes the exact (agentId, nonce) row just CONSUMED, not every row for
  // that agentId (Codex review, T-806 round 1, P1): the winning agent can
  // hold OUTSTANDING permits from EARLIER `/match` runs too (e.g. re-run
  // matching re-recommended the same Agent) — a bare `agent_id != $2`
  // exclusion left those stale rows OUTSTANDING forever, contradicting this
  // function's own contract ("every other candidate's OTHER outstanding
  // rows...must become INVALIDATED") and the fixed invariant "at most one
  // OUTSTANDING/CONSUMED row exists per task" once a task leaves OPEN.
  await client.query(
    `UPDATE acceptance_permits
     SET status = 'INVALIDATED', consumed_at = now()
     WHERE task_id = $1 AND NOT (agent_id = $2 AND nonce = $3) AND status = 'OUTSTANDING'`,
    [taskId, excludeAgentId, excludeNonce],
  );
}

// ---------------------------------------------------------------------
// T-808 (human N6 BLOCK fix, item #4): "我的接单" (`MyAcceptedTasksPage.tsx`)
// must show BOTH the already-accepted state (T-805's `GET
// /tasks?acceptedBy=`) AND the candidate-invitation state (F-806/AC-805) —
// an earlier implementation attempt (T-805) simplified this away on the
// grounds that no "which Agents does this wallet own" query existed yet;
// the human reviewer rejected that simplification as invalid.
//
// Endpoint shape deviation from design.md's draft (pre-authorized by the
// T-808 capsule, not a new business rule): design.md's interface-contract
// section sketches `GET /tasks/agents/:agentId/candidate-invitations`
// (`:agentId`-scoped). This function instead backs a SESSION-scoped
// endpoint, `GET /tasks/agents/candidate-invitations` (no `:agentId`) —
// resolving "every Agent this session owns, and each one's candidacy"
// entirely inside the one query below, in the same module that already
// owns the `recommendation_candidates`/`acceptance_permits` join
// (`getLatestRecommendationCandidates`, `getPermitForAgent`, above). The
// `:agentId`-scoped variant would additionally require a brand-new "list
// my Agents" endpoint plus client-side fan-out across N calls (one per
// owned Agent) — splitting "which Agents do I own" and "which of my
// Agents holds a live invitation" knowledge across two places instead of
// one. Ownership (`agents.owner_address = session.address`) is therefore
// the ONLY permission input this query accepts — never a client-supplied
// address or agentId.
// ---------------------------------------------------------------------

/** One row of `GET /tasks/agents/candidate-invitations` — a task where the
 * caller's session owns an Agent that is currently a live (still-OPEN
 * task, still-OUTSTANDING-and-unexpired permit, latest recommendation
 * round) candidate. Field list matches design.md's interface-contract
 * response shape verbatim, minus the wrapping `{items, total, page,
 * pageSize}` envelope routes.ts adds. */
export interface CandidateInvitation {
  taskId: string;
  category: string;
  title: string;
  /** Decimal text — see `TaskRow.budget`'s (tasks/repository.ts) identical
   * "NUMERIC comes back from pg as a string, never `Number()`-coerced"
   * convention. */
  budget: string;
  deliveryDeadline: Date;
  rank: number;
  slotType: string;
  /** Which of the caller's own Agents holds this invitation — needed
   * because a single session can own more than one candidate Agent, and
   * `MyAcceptedTasksPage.tsx`'s discriminated-union item shape (T-808
   * capsule) surfaces it per invitation, same reasoning as
   * `resolveAcceptingAgentId`'s "never conflate two Agents behind one
   * wallet" precedent above. */
  agentId: string;
}

export interface CandidateInvitationsPage {
  items: CandidateInvitation[];
  total: number;
}

/**
 * `GET /tasks/agents/candidate-invitations`'s (T-808) sole query: every
 * task where a task still `OPEN`, still-`OUTSTANDING`-and-unexpired permit
 * naming one of the CALLER's OWN Agents (via `agents.owner_address =
 * $1`, normalized-lowercase `sessionAddress` — never a client-supplied
 * address or agentId, T-808 capsule's explicit constraint) exists, scoped
 * to that task's LATEST recommendation round only.
 *
 * Each of the four AND-ed conditions below corresponds to one part of
 * "still a live invitation":
 *   - `a.owner_address = $1`: ownership — the only permission input.
 *     Same-wallet-multiple-Agents is never conflated: this join keys off
 *     `rc.agent_id`/`ap.agent_id`/`a.id` throughout, so each Agent's own
 *     candidacy is evaluated independently, exactly like
 *     `resolveAcceptingAgentId`'s "never guess across Agents sharing a
 *     wallet" design (above) — a caller who owns two candidate Agents on
 *     the same task gets two independent rows, one per `agentId`.
 *   - `t.status = 'OPEN'`: a task that has already left OPEN (accepted by
 *     someone else, cancelled, etc.) can no longer be validly invited
 *     into, regardless of what `acceptance_permits.status` says.
 *   - `ap.status = 'OUTSTANDING' AND ap.expiry > extract(epoch from
 *     now())`: the permit itself must still be usable — mirrors
 *     `getPermitForAgent`'s identical "usable" judgment above (this
 *     function is that same query's session-scoped, multi-task,
 *     multi-Agent sibling rather than a re-derivation of the rule).
 *   - the `rr.id = (SELECT ... ORDER BY requested_at DESC, sequence_no
 *     DESC LIMIT 1)` subquery: scopes to the task's LATEST recommendation
 *     round only, same "requested_at DESC, sequence_no DESC" deterministic
 *     tiebreak `getLatestRecommendationCandidates` already established —
 *     a candidate from a SUPERSEDED round must not appear as "still
 *     invited." In practice T-709's round-gating (`hasUnexpiredOutstandingPermits`)
 *     already guarantees at most one round ever has unexpired OUTSTANDING
 *     permits for a given task at a time, so this subquery is redundant
 *     with the `ap.status`/`ap.expiry` filters above for any row that
 *     could otherwise pass them — it is kept anyway as an explicit,
 *     self-contained correctness condition rather than relying on that
 *     invariant holding forever elsewhere in the codebase (defense in
 *     depth, not a second competing rule).
 *
 * `total` comes from an independent `count(*)` query over the same WHERE
 * clause (not a window function) — same reasoning as `listTasks`
 * (tasks/repository.ts): a page beyond the last populated one must not
 * misreport `total` as 0.
 */
export async function getCandidateInvitationsForSession(
  client: Queryable,
  sessionAddress: string,
  pagination: { page: number; pageSize: number },
): Promise<CandidateInvitationsPage> {
  const normalizedAddress = sessionAddress.toLowerCase();
  const offset = (pagination.page - 1) * pagination.pageSize;

  const whereClause = `
    FROM recommendation_candidates rc
    JOIN recommendation_runs rr ON rr.id = rc.run_id
    JOIN tasks t ON t.id = rr.task_id
    JOIN agents a ON a.id = rc.agent_id
    JOIN acceptance_permits ap ON ap.task_id = t.id AND ap.agent_id = rc.agent_id
    WHERE a.owner_address = $1
      AND t.status = 'OPEN'
      AND ap.status = 'OUTSTANDING'
      AND ap.expiry > extract(epoch from now())
      AND rr.id = (
        SELECT id FROM recommendation_runs
        WHERE task_id = t.id
        ORDER BY requested_at DESC, sequence_no DESC
        LIMIT 1
      )
  `;

  const [itemsResult, countResult] = await Promise.all([
    client.query<{
      task_id: string;
      category: string;
      title: string;
      budget: string;
      delivery_deadline: Date;
      rank: number;
      slot_type: string;
      agent_id: string;
    }>(
      `SELECT t.id AS task_id, t.category, t.title, t.budget, t.delivery_deadline,
              rc.rank, rc.slot_type, rc.agent_id
       ${whereClause}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $2 OFFSET $3`,
      [normalizedAddress, pagination.pageSize, offset],
    ),
    client.query<{ total: string }>(`SELECT count(*)::text AS total ${whereClause}`, [
      normalizedAddress,
    ]),
  ]);

  return {
    items: itemsResult.rows.map((row) => ({
      taskId: row.task_id,
      category: row.category,
      title: row.title,
      budget: row.budget,
      deliveryDeadline: row.delivery_deadline,
      rank: row.rank,
      slotType: row.slot_type,
      agentId: row.agent_id,
    })),
    total: Number(countResult.rows[0]?.total ?? "0"),
  };
}
