import { resolveChainConfig, type ChainConfig, type ErrorCode } from "@agent-market/domain";
import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import { verifyAcceptanceTransaction } from "../chain/acceptance-tx-verifier.js";
import { verifyDisputeOpenTransaction } from "../chain/dispute-open-tx-verifier.js";
import { verifyDisputeResolveTransaction } from "../chain/dispute-resolve-tx-verifier.js";
import {
  decodeAcceptedEventsFromLogs,
  decodeDeliveryTimeoutClaimedEventsFromLogs,
  decodeDisputeOpenedEventsFromLogs,
  decodeDisputeResolvedEventsFromLogs,
  decodeFundedEventsFromLogs,
  decodeResultApprovedEventsFromLogs,
  decodeResultSubmittedEventsFromLogs,
  decodeReviewTimeoutFinalizedEventsFromLogs,
} from "../chain/event-sync.js";
import type { ChainRpcClient } from "../chain/rpc.client.js";
import { verifyResultSubmissionTransaction } from "../chain/result-submission-tx-verifier.js";
import { applySettlementStats, type SettlementEventKind } from "../chain/settlement-stats.js";
import { verifySettlementTransaction } from "../chain/settlement-tx-verifier.js";
import { checkTransactionNotUsed, verifyFundingTransaction } from "../chain/tx-verifier.js";
import {
  consumeAcceptancePermits,
  invalidateOtherOutstandingPermits,
  resolveAcceptingAgentId,
} from "../dispatch/repository.js";
import {
  getOpenDisputeForTask,
  insertAuditLog,
  resolveDispute as resolveDisputeRow,
} from "../disputes/repository.js";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import {
  findChainTransactionOwner,
  findDraftByIdempotencyKey,
  getChainTransactionByHash,
  getTaskById,
  getTaskHistory,
  insertChainEvent,
  insertChainTransaction,
  insertTaskDraft,
  listTasks,
  transitionTaskStatus,
  updateTaskDraft,
  type ListTasksResult,
  type TaskRow,
  type TaskStateHistoryEntry,
  type TaskStatusValue,
} from "./repository.js";
import type { CreateDraftInput, ListTasksQuery, UpdateDraftInput } from "./schema.js";

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
// Placeholder until Feature 2's deployed YD Token address is wired through
// (0005_create_tasks.sql's header comment: "token ... populated by the
// application layer even though it is not part of the POST /tasks/drafts
// request body"). Matches .env.example's own convention of defaulting
// on-chain addresses (TASK_ESCROW_ADDRESS/YD_TOKEN_ADDRESS/YD_FAUCET_ADDRESS)
// to the zero address pre-deployment, rather than this module inventing a
// second placeholder convention. `modules/chain/*` (T-603, out of this
// task's scope) is expected to be the actual consumer/source of a real,
// non-zero deployed address once it exists; this task only needs *some*
// well-formed value to satisfy `tasks.token`'s NOT NULL + format CHECK so
// draft creation isn't blocked on chain wiring that hasn't landed yet.
const DEFAULT_YD_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

function resolveYdTokenAddress(): string {
  const raw = process.env.YD_TOKEN_ADDRESS;
  if (raw && HEX_ADDRESS_PATTERN.test(raw)) {
    return raw.toLowerCase();
  }
  return DEFAULT_YD_TOKEN_ADDRESS;
}

/** `pg` reports a unique-constraint violation as SQLSTATE `23505`
 * (https://www.postgresql.org/docs/current/errcodes-appendix.html). The
 * `tasks` table's only unique constraint besides its primary key is
 * `tasks_requester_idempotency_key_unique` (0005_create_tasks.sql), so any
 * `23505` surfacing from `insertTaskDraft` is that constraint. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Feature 14 (T-609): true idempotency-key semantics — a replay under the
 * same key is only "the same logical request recalled" if its payload is
 * ACTUALLY the same. Compares every field the client controls (not
 * `requesterAddress`/`token`, which are server-derived and therefore can't
 * legitimately differ between two calls carrying the same key from the
 * same session). `skillTags` compared as a set (order/duplicates
 * irrelevant — `createDraft` itself already de-duplicates before storage,
 * see its own `[...new Set(...)]` call).
 *
 * Codex review (T-609 P2): `budget` is compared as a `BigInt`, not the raw
 * string. `BUDGET_SCHEMA`'s pattern (`/^\d+$/`) accepts leading zeros
 * (e.g. `"001"`), but PostgreSQL's `NUMERIC` column normalizes them away on
 * read-back (`existing.budget` comes back as `"1"`) — a genuinely identical
 * retry that happens to reuse a leading-zero literal would otherwise fail
 * a raw string comparison and be wrongly rejected as a conflict.
 * `BigInt(...)` is safe here specifically because both sides are already
 * guaranteed to be valid unsigned-integer strings by this point (Zod
 * validated `input.budget`; `existing.budget` only ever came from this
 * same schema's own prior INSERT).
 */
function draftPayloadMatches(existing: TaskRow, input: CreateDraftInput): boolean {
  if (
    existing.category !== input.category ||
    existing.title !== input.title ||
    existing.description !== input.description ||
    BigInt(existing.budget) !== BigInt(input.budget) ||
    existing.expertType !== input.expertType ||
    existing.deliveryDeadline.getTime() !== new Date(input.deliveryDeadline).getTime()
  ) {
    return false;
  }
  const existingSkillTags = [...new Set(existing.skillTags)].sort();
  const inputSkillTags = [...new Set(input.skillTags)].sort();
  return (
    existingSkillTags.length === inputSkillTags.length &&
    existingSkillTags.every((tag, index) => tag === inputSkillTags[index])
  );
}

/**
 * F-601/AC-601: creates a `DRAFT` task owned by `sessionAddress` (the
 * caller's verified session address — routes.ts gets this from
 * `request.address`, never from request body input, mirroring agents/
 * service.ts's `createAgent`).
 *
 * Idempotency (F-601 "支持客户端幂等键" / the capsule's core
 * requirement): when `idempotencyKey` is supplied, an existing task created
 * by the same requester with the same key AND THE SAME PAYLOAD is returned
 * as-is instead of inserting a duplicate — a genuine retry (network
 * failure, double-click) of the identical logical request. T-609 (Feature
 * 14, F-1405): if the stored payload DIFFERS from this call's payload, that
 * is a real client bug (reusing a key for a materially different request),
 * not a legitimate replay — this now returns `idempotency_key_conflict`
 * instead of silently discarding the caller's new data and returning the
 * old task as if nothing were wrong. Two request phases both need the
 * lookup:
 *
 * 1. Up front (`findDraftByIdempotencyKey` before insert) — the common
 *    case, avoids even attempting an insert that's already been done.
 * 2. After a caught `23505` from the insert itself — the concurrency case:
 *    two requests with the same key can both pass step 1 (neither's insert
 *    has committed yet when the other checks), both then attempt the
 *    insert, and exactly one wins; the loser's insert throws instead of
 *    silently duplicating the row. Catching that and re-querying (rather
 *    than letting a 500 reach the client) is what makes the idempotency
 *    contract atomic under real concurrency instead of merely "usually
 *    works" — the DB's UNIQUE constraint is the actual synchronization
 *    point, application code only needs to translate its failure mode into
 *    the same success response the winner got (or the same conflict, if
 *    the winner's payload also differs from this caller's).
 */
export type CreateDraftResult =
  | {
      ok: true;
      task: TaskRow;
      /** False when this call returned an existing row via idempotency-key
       * replay (either the fast path or the concurrent-race catch below)
       * rather than performing a genuine insert. Callers that trigger side
       * effects meant to happen once per save (e.g. T-1302's embedding
       * generation) must check this before firing them — a replay is the
       * same save event recalled, not a new one. */
      isNewlyCreated: boolean;
    }
  | { ok: false; reason: "idempotency_key_conflict" };

export async function createDraft(
  pool: Pool,
  sessionAddress: string,
  input: CreateDraftInput,
  idempotencyKey: string | null,
): Promise<CreateDraftResult> {
  const requesterAddress = normalizeAddress(sessionAddress);
  const skillTags = [...new Set(input.skillTags)];
  const token = resolveYdTokenAddress();

  if (idempotencyKey) {
    const existing = await findDraftByIdempotencyKey(pool, requesterAddress, idempotencyKey);
    if (existing) {
      if (!draftPayloadMatches(existing, input)) {
        return { ok: false, reason: "idempotency_key_conflict" };
      }
      return { ok: true, task: existing, isNewlyCreated: false };
    }
  }

  try {
    const task = await insertTaskDraft(pool, {
      requesterAddress,
      category: input.category,
      title: input.title,
      description: input.description,
      budget: input.budget,
      token,
      deliveryDeadline: new Date(input.deliveryDeadline),
      idempotencyKey,
      skillTags,
      expertType: input.expertType,
    });
    return { ok: true, task, isNewlyCreated: true };
  } catch (error) {
    if (idempotencyKey && isUniqueViolation(error)) {
      const existing = await findDraftByIdempotencyKey(pool, requesterAddress, idempotencyKey);
      if (existing) {
        if (!draftPayloadMatches(existing, input)) {
          return { ok: false, reason: "idempotency_key_conflict" };
        }
        return { ok: true, task: existing, isNewlyCreated: false };
      }
    }
    throw error;
  }
}

/** DRAFT/AWAITING_FUNDING tasks are pre-publication — only visible to the
 * authenticated session matching their own `requesterAddress`, per
 * `getTaskDetail`'s doc comment (Codex review, T-605 round 1, P1). */
function isPrePublicationStatus(status: TaskStatusValue): boolean {
  return status === "DRAFT" || status === "AWAITING_FUNDING";
}

/**
 * F-601/F-602/T-605: `null` both when no task exists with this id AND when
 * it exists but is still DRAFT/AWAITING_FUNDING and `viewerAddress` isn't
 * its owner — routes.ts turns either case into the same 404, deliberately
 * not distinguishing them in the response (Codex review, T-605 round 1,
 * P1): a 403/"exists but hidden" response would itself leak that a task ID
 * exists and who owns it, defeating the point of hiding an unpublished
 * draft from everyone but its owner. `viewerAddress` is the caller's
 * authenticated session address if any (`null` for an anonymous request) —
 * routes.ts reads it via `readOptionalSessionAddress`, this function never
 * requires a session, it only uses one if present to decide visibility.
 */
export async function getTaskDetail(
  pool: Queryable,
  taskId: string,
  viewerAddress: string | null,
): Promise<TaskRow | null> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return null;
  }
  if (isPrePublicationStatus(task.status) && task.requesterAddress !== viewerAddress) {
    return null;
  }
  return task;
}

/**
 * T-605/F-608: normalizes `requester` (matching every other address-bearing
 * write/read in this module) and decides `restrictToPublicStatuses` — the
 * one authorization judgment `listTasks` (repository.ts) is NOT allowed to
 * make on its own (Codex review, T-605 round 1, P1; see
 * `ListTasksFilter.restrictToPublicStatuses`'s doc comment). DRAFT/
 * AWAITING_FUNDING tasks are only included when the caller is authenticated
 * AND `query.requester` is exactly that same address — an anonymous caller,
 * or one asking about a DIFFERENT address, always gets the public-market
 * view regardless of what `requester`/`status` they passed.
 */
export async function listTasksForMarket(
  pool: Queryable,
  query: ListTasksQuery,
  viewerAddress: string | null,
): Promise<ListTasksResult> {
  const normalizedRequester = query.requester ? normalizeAddress(query.requester) : undefined;
  const isViewingOwnTasks =
    normalizedRequester !== undefined && normalizedRequester === viewerAddress;
  // T-805: `acceptedBy` normalized the same way `requester` is (both are
  // caller-supplied addresses compared against a lowercase-stored column) —
  // no ownership check needed here, see `ListTasksFilter.acceptedBy`'s doc
  // comment (repository.ts) for why.
  const normalizedAcceptedBy = query.acceptedBy ? normalizeAddress(query.acceptedBy) : undefined;

  return listTasks(pool, {
    requester: normalizedRequester,
    acceptedBy: normalizedAcceptedBy,
    status: query.status,
    category: query.category,
    skillTag: query.skillTag,
    page: query.page,
    pageSize: query.pageSize,
    restrictToPublicStatuses: !isViewingOwnTasks,
  });
}

/** T-605: `[]` both for "task exists, no recorded transitions" and for
 * "task doesn't exist" — routes.ts distinguishes the latter with its own
 * `getTaskById` 404 check before calling this, matching design.md's
 * `GET /tasks/:taskId/history` contract (a task's history is a sub-resource
 * of the task, not a resource with its own independent existence). */
export async function getTaskStateHistory(
  pool: Queryable,
  taskId: string,
): Promise<TaskStateHistoryEntry[]> {
  return getTaskHistory(pool, taskId);
}

/**
 * Shared ownership/state-check result shape for `updateDraft`: `not_found`
 * (no such task — 404), `forbidden` (task exists but `sessionAddress` isn't
 * its requester — 403), and `not_draft` (task exists, caller owns it, but
 * `status` is no longer `DRAFT` — 409) need different HTTP statuses, so
 * routes.ts must be able to tell them apart rather than this layer
 * collapsing them into a single boolean, mirroring agents/service.ts's
 * `AgentMutationResult`.
 */
export type TaskDraftMutationResult =
  { ok: true; task: TaskRow } | { ok: false; reason: "not_found" | "forbidden" | "not_draft" };

/**
 * F-602: applies a partial edit to a draft, but only after confirming
 * `sessionAddress` is the task's requester (ownership check, same shape as
 * AC-505's Agent-ownership rule) and that the task is still `status =
 * 'DRAFT'` — editing any other status is rejected with a distinct reason
 * rather than silently allowed (the capsule's explicit instruction: "只允许
 * 编辑 status='DRAFT' 的任务，其他状态编辑应返回明确错误，不要静默允许").
 * The draft-status check itself happens inside `updateTaskDraft`'s own
 * transaction (repository.ts) — checking here first would be a race
 * (status could flip between this check and the UPDATE).
 */
export async function updateDraft(
  pool: Pool,
  sessionAddress: string,
  taskId: string,
  input: UpdateDraftInput,
): Promise<TaskDraftMutationResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }
  if (task.requesterAddress !== normalizeAddress(sessionAddress)) {
    return { ok: false, reason: "forbidden" };
  }

  const result = await updateTaskDraft(pool, taskId, {
    category: input.category,
    title: input.title,
    description: input.description,
    budget: input.budget,
    deliveryDeadline: input.deliveryDeadline ? new Date(input.deliveryDeadline) : undefined,
    skillTags: input.skillTags ? [...new Set(input.skillTags)] : undefined,
    expertType: input.expertType,
  });

  if (result.outcome === "not_found") {
    // Existed at the ownership check above but is gone now — a concurrent
    // delete would be the only way this branch is reachable (no delete
    // endpoint exists yet, so this is defensive, not expected), mirroring
    // agents/service.ts's updateAgent.
    return { ok: false, reason: "not_found" };
  }
  if (result.outcome === "not_draft") {
    return { ok: false, reason: "not_draft" };
  }
  return { ok: true, task: result.task };
}

// ---------------------------------------------------------------------
// T-604: funding-intent + funding-verifications (DRAFT → AWAITING_FUNDING →
// OPEN). Both share the same trusted TaskEscrow address/chain id, resolved
// once here (not re-parsed separately in each function) — the same value
// `verifyFundingTransaction`'s `trustedContractAddress` param is checked
// against, so a frontend building a `createTask` call from
// `createFundingIntent`'s response and a later `verifyFunding` call are
// always talking about the identical contract.
// ---------------------------------------------------------------------

/**
 * Resolves this backend's trusted chain/contract configuration
 * (`CHAIN_ID`/`TASK_ESCROW_ADDRESS`/`YD_TOKEN_ADDRESS`/`YD_FAUCET_ADDRESS`
 * env vars, packages/domain's `resolveChainConfig`). Deliberately not
 * memoized: reading `process.env` at call time (matching
 * `rpc.client.ts`'s `createChainRpcClient`) keeps this test-friendly — a
 * test can set the env vars right before calling `createFundingIntent`/
 * `verifyFunding` without needing a module-reload trick.
 */
function resolveFundingChainConfig(): ChainConfig {
  return resolveChainConfig(process.env);
}

/**
 * Thrown from inside `transitionTaskStatus`'s `withinTransaction` callback
 * (never caught there — `transitionTaskStatus` already ROLLBACKs and
 * rethrows on any error) when `insertChainTransaction`'s `ON CONFLICT (chain_id,
 * tx_hash) DO NOTHING` reports the row was *not* created by this call, and
 * the row that already exists belongs to a *different* task than the one
 * currently being funded.
 *
 * This is the actual race-free enforcement of "txHash 已绑定另一个任务"
 * (Codex review P1: the earlier `checkTransactionNotUsed` pre-check, run
 * *before* this transaction opens, cannot see a row inserted by a
 * concurrent request that commits in between — only the UNIQUE constraint
 * inside this same transaction can). `verifyFunding` catches this
 * specifically to translate it into a `TRANSACTION_ALREADY_USED`
 * `chain_error` result instead of letting it surface as an unhandled 500.
 */
class TransactionAlreadyUsedByAnotherTaskError extends Error {
  readonly occupantTaskId: string;

  constructor(occupantTaskId: string) {
    super(`transaction already bound to task ${occupantTaskId}`);
    this.name = "TransactionAlreadyUsedByAnotherTaskError";
    this.occupantTaskId = occupantTaskId;
  }
}

/**
 * Thrown from inside `transitionTaskStatus`'s `withinTransaction` callback
 * (never caught there — `transitionTaskStatus` already ROLLBACKs and
 * rethrows on any error) when `resolveDisputeRow`'s `UPDATE ... WHERE
 * task_id = $1 AND status = 'OPEN'` matches zero rows.
 *
 * By this point in `verifyDisputeResolution`, the task's own row is
 * confirmed `DISPUTED` under `transitionTaskStatus`'s row lock (the
 * transaction only reaches this callback for `allowedFromStatuses:
 * ["DISPUTED"]`) — a legitimate retried/idempotent replay of an ALREADY-
 * resolved dispute is handled entirely by the earlier RELEASED/REFUNDED +
 * `findExistingDisputeResolveForTask` branch, before this transaction ever
 * opens. So reaching here with zero matching rows means the `disputes` row
 * itself is missing or already resolved while `tasks.status` still says
 * DISPUTED — a genuine `tasks`/`disputes` inconsistency, not a routine
 * no-op. `verifyDisputeResolution` catches this specifically to roll back
 * the whole transaction (status UPDATE, stats, chain_transactions,
 * chain_events, the `users` upsert, and the audit log all undone together)
 * instead of silently committing a settlement with an unresolved dispute
 * row underneath it.
 */
class DisputeRowNotOpenError extends Error {
  constructor(taskId: string) {
    super(`no OPEN dispute row for task ${taskId} despite task.status = DISPUTED`);
    this.name = "DisputeRowNotOpenError";
  }
}

const DEFAULT_REQUIRED_CONFIRMATIONS = 1;

/**
 * How many block confirmations `verifyFundingTransaction` requires before
 * treating a funding transaction as final (F-605's "达到确认数"). Not part
 * of `chain-config.ts` — that module resolves chain *identity* (which
 * network, which contract addresses), not this deployment's confirmation
 * policy, so this stays a T-604-local concern. Defaults to 1 (the
 * transaction's own block) when unset or not a valid positive integer,
 * matching a local Hardhat node's near-instant finality; a real deployment
 * sets `FUNDING_REQUIRED_CONFIRMATIONS` explicitly for its own reorg-risk
 * tolerance.
 */
export function resolveRequiredConfirmations(): number {
  const raw = process.env.FUNDING_REQUIRED_CONFIRMATIONS;
  if (!raw) {
    return DEFAULT_REQUIRED_CONFIRMATIONS;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_REQUIRED_CONFIRMATIONS;
  }
  return parsed;
}

export interface FundingIntent {
  contractAddress: `0x${string}`;
  token: `0x${string}`;
  /** Decimal text — see TaskRow's `budget` field doc comment. */
  budget: string;
  /** Unix seconds — the same unit `TaskEscrow.createTask`'s `uint64
   * deliveryDeadline` parameter expects, so the frontend can pass this
   * value straight into the transaction it builds without a second
   * conversion (and without risking a different rounding rule than the one
   * `tx-verifier.ts`'s `toUnixSeconds` uses to check it later). */
  deliveryDeadline: number;
  taskIdOnChain: `0x${string}`;
}

export type FundingIntentResult =
  | { ok: true; intent: FundingIntent }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "conflict"; currentStatus: TaskStatusValue }
  | { ok: false; reason: "expired_deadline" };

/**
 * F-604's first step: mints the parameters the frontend needs to build its
 * `TaskEscrow.createTask` transaction, transitioning the task
 * DRAFT→AWAITING_FUNDING in the process.
 *
 * Idempotent by design (capsule: "幂等：已经是 AWAITING_FUNDING 也允许，返回
 * 同样的 intent，不报错") — a task already `AWAITING_FUNDING` (e.g. the
 * frontend retried after a network blip, or the user reopened the create
 * flow) gets the same intent back rather than a conflict, since
 * `budget`/`token`/`deliveryDeadline`/`taskIdOnChain` are all pure
 * functions of the (unchanged, no-longer-editable) task row. Any other
 * status is a genuine conflict — funding a task that's already `OPEN` or
 * further along makes no sense.
 */
export async function createFundingIntent(
  pool: Pool,
  sessionAddress: string,
  taskId: string,
): Promise<FundingIntentResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }
  if (task.requesterAddress !== normalizeAddress(sessionAddress)) {
    return { ok: false, reason: "forbidden" };
  }
  if (task.status !== "DRAFT" && task.status !== "AWAITING_FUNDING") {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }

  // Resolve (and let it throw on missing/invalid config) BEFORE the
  // DRAFT→AWAITING_FUNDING transition below, not after. Resolving it only
  // once the transition has already committed would leave a real failure
  // mode: the transition succeeds, the response 500s with no intent ever
  // returned, and the task is now stuck AWAITING_FUNDING — every retry
  // re-hits the same broken config and gets the same 500, with no way back
  // to DRAFT to try again (Codex review, T-604 round 2, P1).
  const chainConfig = resolveFundingChainConfig();

  if (task.status === "DRAFT") {
    const transition = await transitionTaskStatus(pool, {
      taskId,
      allowedFromStatuses: ["DRAFT"],
      toStatus: "AWAITING_FUNDING",
      actor: task.requesterAddress,
      reason: "funding intent created",
      // `TaskEscrow.createTask` reverts (`InvalidDeliveryDeadline`) when
      // `deliveryDeadline <= block.timestamp`. schema.ts's
      // DELIVERY_DEADLINE_SCHEMA only checked this at draft-creation time —
      // a deadline valid then can still have passed by the time the user
      // actually starts funding. This MUST run inside the row lock, not as
      // a plain `Date.now()` check before calling `transitionTaskStatus`:
      // a pre-lock check can pass, then this call blocks waiting for the
      // lock while a concurrent writer changes the deadline (or time simply
      // advances past it) before the lock is actually granted — a
      // TOCTOU gap that would let an already-expired deadline still commit
      // the transition (human review, T-605 round 3). Re-reading the row
      // via `getTaskById(client, ...)` rather than trusting the `task`
      // captured above is deliberate: `client` is inside the same
      // transaction holding the lock, so this sees the row as of the
      // moment the lock was granted, not as of the read before this call.
      precondition: async (client) => {
        const locked = await getTaskById(client, taskId);
        if (locked && locked.deliveryDeadline.getTime() <= Date.now()) {
          return { ok: false, reason: "expired_deadline" };
        }
        return { ok: true };
      },
    });
    if (transition.outcome === "not_found") {
      return { ok: false, reason: "not_found" };
    }
    if (transition.outcome === "precondition_failed") {
      return { ok: false, reason: "expired_deadline" };
    }
    if (transition.outcome === "conflict" && transition.currentStatus !== "AWAITING_FUNDING") {
      // Raced with something that moved the task past AWAITING_FUNDING
      // between the read above and this transition's own row lock.
      return { ok: false, reason: "conflict", currentStatus: transition.currentStatus };
    }
    // Either transitioned, or lost a race to a concurrent
    // funding-intent call that got it to AWAITING_FUNDING first — both are
    // the idempotent success case from here on.
  }

  const deliveryDeadlineSeconds = Math.floor(task.deliveryDeadline.getTime() / 1000);

  return {
    ok: true,
    intent: {
      contractAddress: chainConfig.addresses.taskEscrow,
      token: task.token as `0x${string}`,
      budget: task.budget,
      deliveryDeadline: deliveryDeadlineSeconds,
      taskIdOnChain: deriveOnChainTaskId(task.id),
    },
  };
}

export type FundingVerificationServiceResult =
  | { ok: true; status: "OPEN"; confirmations: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "conflict"; currentStatus: TaskStatusValue }
  | { ok: false; reason: "chain_error"; code: ErrorCode; message: string };

/**
 * F-604/F-605/F-606's second step: verifies a submitted `txHash` against
 * this task's draft data using T-603's `tx-verifier.ts` (no validation
 * rule is reimplemented here — this function only orchestrates: look up
 * the task, call the verifier, translate its result into a state
 * transition or a passthrough error).
 *
 * - RPC-layer failures (`verifyFundingTransaction` returning `ok: false`)
 *   are returned as `chain_error` and never touch `tasks.status` — F-606's
 *   "RPC 不可用时任务保持待确认，不标记失败" requires the caller (routes.ts)
 *   to be able to tell "still pending" apart from "verification failed",
 *   which is exactly what NOT transitioning state here preserves.
 * - `checkTransactionNotUsed` runs only after `verifyFundingTransaction`
 *   succeeds (T-603's own ordering rationale: no point spending a DB
 *   round-trip on an event that didn't even match).
 * - The final AWAITING_FUNDING→OPEN transition, the `chain_transactions`
 *   row, and the `chain_events` row all commit in one transaction
 *   (`transitionTaskStatus`'s `withinTransaction` hook) — "任务状态是 OPEN"
 *   and "资金交易已记录" must never be observably out of sync.
 */
export async function verifyFunding(
  pool: Pool,
  rpc: ChainRpcClient,
  sessionAddress: string,
  taskId: string,
  txHash: string,
): Promise<FundingVerificationServiceResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }
  if (task.requesterAddress !== normalizeAddress(sessionAddress)) {
    return { ok: false, reason: "forbidden" };
  }
  if (task.status !== "AWAITING_FUNDING" && task.status !== "OPEN") {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }

  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const chainConfig = resolveFundingChainConfig();

  // F-606 idempotent replay: an already-OPEN task resubmitting the exact
  // txHash it was funded with skips re-verification entirely, rather than
  // re-running RPC calls (or worse, attempting a second AWAITING_FUNDING→
  // OPEN transition that would rightly fail as a conflict) for a result
  // already committed.
  if (task.status === "OPEN" && task.fundingTxHash === normalizedTxHash) {
    const existing = await getChainTransactionByHash(pool, chainConfig.chainId, normalizedTxHash);
    return { ok: true, status: "OPEN", confirmations: existing?.confirmations ?? 0 };
  }

  const taskIdOnChain = deriveOnChainTaskId(task.id);
  const requiredConfirmations = resolveRequiredConfirmations();

  const verification = await verifyFundingTransaction({
    rpc,
    txHash: normalizedTxHash,
    expectedChainId: chainConfig.chainId,
    trustedContractAddress: chainConfig.addresses.taskEscrow,
    requiredConfirmations,
    expected: {
      taskIdOnChain,
      requesterAddress: task.requesterAddress as `0x${string}`,
      token: task.token as `0x${string}`,
      budget: task.budget,
      deliveryDeadline: task.deliveryDeadline,
    },
  });

  if (!verification.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: verification.code,
      message: verification.message,
    };
  }

  // Fast-fail pre-check, run before opening a transaction — cheap enough to
  // be worth skipping the case that's already obviously hopeless (this
  // txHash is visibly claimed by another task), but NOT the actual
  // correctness guarantee: two concurrent `verifyFunding` calls for
  // different tasks can both pass this check (neither's insert has
  // committed yet when the other reads), so the real, race-free
  // enforcement lives inside `transitionTaskStatus`'s transaction below via
  // `insertChainTransaction`'s `ON CONFLICT ... DO NOTHING` +
  // `TransactionAlreadyUsedByAnotherTaskError` (Codex review P1).
  const usage = await checkTransactionNotUsed(pool, chainConfig.chainId, normalizedTxHash, taskId);
  if (!usage.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: usage.code ?? "TRANSACTION_ALREADY_USED",
      message: usage.message ?? "transaction already bound to another task",
    };
  }

  // `verifyFundingTransaction`'s result deliberately doesn't expose the
  // matched log's index (tx-verifier.ts's `VerifiedFundingEvent` has no
  // `logIndex` field) — chain_events' identity needs it, so this re-fetches
  // the same receipt and reuses event-sync.ts's already-shared
  // `decodeFundedEventsFromLogs` (not a second decode implementation) to
  // recover it, rather than tx-verifier.ts's own reviewed return shape
  // being changed for this one extra field.
  //
  // This second RPC call gets the same try/catch treatment
  // `verifyFundingTransaction` already gives its own `getTransactionReceipt`
  // call (tx-verifier.ts) — an RPC failure here (network blip/timeout) must
  // become `RPC_TEMPORARILY_UNAVAILABLE`, not an unhandled exception
  // reaching routes.ts as a 500 (Codex review P1). The task hasn't started
  // its status transition yet at this point, so "don't change status" falls
  // out for free.
  let receipt: Awaited<ReturnType<ChainRpcClient["getTransactionReceipt"]>>;
  try {
    receipt = await rpc.getTransactionReceipt(normalizedTxHash);
  } catch (error) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
  // The receipt just fetched must be the SAME receipt `verifyFundingTransaction`
  // already verified (same canonical block) — not merely "some receipt for
  // this txHash". Between the two RPC calls, a reorg (or an inconsistent
  // RPC response) could return a receipt from a different block, whose
  // `logIndex` would then get combined with `verification.blockHash` (from
  // the FIRST call) into a `chain_events` row describing a block/log pair
  // that was never actually verified together. Checking `blockHash` equality
  // is what pins this second fetch to the exact snapshot the verification
  // above already confirmed canonical (Codex review, T-604 round 2, P1).
  if (!receipt || receipt.blockHash.toLowerCase() !== verification.blockHash.toLowerCase()) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt snapshot changed between verification and event recording (possible reorg)",
    };
  }
  const decodedEvents = decodeFundedEventsFromLogs(receipt.logs, chainConfig.addresses.taskEscrow);
  const matchingEvent = decodedEvents.find(
    (candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase(),
  );
  if (!matchingEvent) {
    // Verification just succeeded reading this same receipt moments ago —
    // this branch means the RPC gave an inconsistent answer between the two
    // calls (or a genuinely transient failure on the second one). Treated
    // as RPC_TEMPORARILY_UNAVAILABLE, not a verification failure, so the
    // task stays AWAITING_FUNDING and a retry can succeed once the RPC is
    // consistent again.
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt logs were not available when recording the funding event",
    };
  }

  let transition;
  try {
    transition = await transitionTaskStatus(pool, {
      taskId,
      allowedFromStatuses: ["AWAITING_FUNDING"],
      toStatus: "OPEN",
      actor: task.requesterAddress,
      reason: "funding transaction verified",
      extraColumns: { funding_tx_hash: normalizedTxHash },
      withinTransaction: async (client) => {
        const inserted = await insertChainTransaction(client, {
          txHash: normalizedTxHash,
          chainId: chainConfig.chainId,
          taskId,
          purpose: "FUNDING",
          status: "confirmed",
          confirmations: verification.confirmations,
        });
        if (!inserted) {
          // Lost the race for this (chainId, txHash) — the unique
          // constraint already has a row for it. Find out who actually
          // owns it, still inside this same transaction/client.
          const occupantTaskId = await findChainTransactionOwner(
            client,
            chainConfig.chainId,
            normalizedTxHash,
          );
          if (occupantTaskId !== taskId) {
            // Genuinely claimed by a different task — abort this
            // transition entirely (thrown error → transitionTaskStatus's
            // own catch ROLLBACKs and rethrows, so the OPEN transition
            // never commits).
            throw new TransactionAlreadyUsedByAnotherTaskError(occupantTaskId ?? "unknown");
          }
          // Same task racing itself (e.g. a client retry) — the row this
          // task needs already exists, nothing more to do here.
        }
        await insertChainEvent(client, {
          chainId: chainConfig.chainId,
          blockHash: verification.blockHash.toLowerCase(),
          transactionHash: normalizedTxHash,
          logIndex: matchingEvent.logIndex,
          eventName: "TaskFunded",
          taskId,
          payload: {
            taskId: matchingEvent.event.taskId,
            requester: matchingEvent.event.requester,
            token: matchingEvent.event.token,
            budget: matchingEvent.event.budget.toString(),
            deliveryDeadline: matchingEvent.event.deliveryDeadline.toString(),
          },
        });
      },
    });
  } catch (error) {
    if (error instanceof TransactionAlreadyUsedByAnotherTaskError) {
      return {
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
        message: `tx ${normalizedTxHash} on chain ${chainConfig.chainId} is already bound to task ${error.occupantTaskId}`,
      };
    }
    throw error;
  }

  if (transition.outcome === "not_found") {
    return { ok: false, reason: "not_found" };
  }
  if (transition.outcome === "conflict") {
    // A concurrent verification of the SAME task+txHash can legitimately
    // lose this race: both requests pass the `AWAITING_FUNDING` checks
    // above, both independently verify the same on-chain transaction, but
    // only one wins the row lock in `transitionTaskStatus` and actually
    // performs the AWAITING_FUNDING→OPEN transition — the other arrives
    // here with `currentStatus: "OPEN"` and would otherwise get a 409 for
    // a request that, from the caller's point of view, fully succeeded
    // (Codex review, T-604 round 2, P2: "对 overlapping retry 也应该幂等").
    // Re-reading the task and confirming its `funding_tx_hash` matches THIS
    // request's txHash distinguishes that case from a genuine conflict
    // (e.g. the task raced to OPEN via some other, different transaction).
    if (transition.currentStatus === "OPEN") {
      const current = await getTaskById(pool, taskId);
      if (current?.fundingTxHash === normalizedTxHash) {
        const existing = await getChainTransactionByHash(
          pool,
          chainConfig.chainId,
          normalizedTxHash,
        );
        return { ok: true, status: "OPEN", confirmations: existing?.confirmations ?? 0 };
      }
    }
    return { ok: false, reason: "conflict", currentStatus: transition.currentStatus };
  }

  return { ok: true, status: "OPEN", confirmations: verification.confirmations };
}

export type TaskAcceptanceVerificationServiceResult =
  | { ok: true; status: "ACCEPTED"; confirmations: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; currentStatus: TaskStatusValue }
  | { ok: false; reason: "chain_error"; code: ErrorCode; message: string };

/**
 * T-801's idempotent-replay lookup: does a `chain_transactions` row already
 * exist for `(chainId, txHash)`, and does it belong to `taskId`? Unlike
 * `verifyFunding`'s equivalent check (which compares against
 * `tasks.funding_tx_hash`, a persisted column on `tasks`), there is no
 * dedicated `accepted_tx_hash` column — design.md's data model never
 * defines one, and `chain_transactions` already records exactly this fact
 * (this Task now issues `purpose: "ACCEPTANCE"` rows there), so adding a
 * second, redundant place to store the same information would be new
 * design knowledge with no new home (CLAUDE.md 原则 6). Shared by both of
 * `verifyAcceptance`'s replay-check call sites below.
 */
async function findExistingAcceptanceForTask(
  pool: Pool,
  chainId: number,
  taskId: string,
  txHash: string,
): Promise<{ confirmations: number } | null> {
  // `purpose: "ACCEPTANCE"` (Codex review, T-801 round 1, P2): without it, a
  // task's own recorded `FUNDING` transaction hash — which also has this
  // same `taskId` — would satisfy this lookup, letting a caller resubmit
  // the task's funding txHash as if it were a valid acceptance replay.
  const existing = await getChainTransactionByHash(pool, chainId, txHash, "ACCEPTANCE");
  if (existing && existing.taskId === taskId) {
    return { confirmations: existing.confirmations };
  }
  return null;
}

/**
 * F-801/F-802/F-803, T-801's second step (the task capsule's confirmed
 * scope decision #2): mirrors `verifyFunding`'s exact structure — look up
 * the task, idempotently replay an already-`ACCEPTED` task resubmitting the
 * same txHash it was accepted with, otherwise independently RPC-verify the
 * `TaskAccepted` event and atomically transition `OPEN`→`ACCEPTED`
 * alongside the `chain_transactions`/`chain_events` rows and this task's
 * outstanding `acceptance_permits` rows — all in one
 * `transitionTaskStatus` transaction, so "任务状态是 ACCEPTED" and "接单交易已
 * 记录" can never be observably out of sync (design.md's "四者原子一致").
 *
 * Unlike `verifyFunding`, there is no pre-existing "owner" to check
 * `sessionAddress` against before verification even starts — acceptance is
 * exactly the event that establishes who accepted, so there is nothing to
 * compare the caller against yet. Ownership is instead enforced *through*
 * verification: `verifyAcceptanceTransaction`'s `expected.agentAddress`
 * requires the decoded event's `agent` to equal the caller's own session
 * address, mirroring `TaskEscrow.acceptTask`'s own on-chain `permit.agent
 * == msg.sender` requirement — a stranger submitting someone else's txHash
 * gets the same `chain_error` (reusing `FUNDING_EVENT_MISMATCH`, the
 * closest existing code — see acceptance-tx-verifier.ts's header comment
 * on why no new ErrorCode is introduced) a genuinely mismatched event
 * would, rather than a separate `forbidden` branch.
 */
export async function verifyAcceptance(
  pool: Pool,
  rpc: ChainRpcClient,
  sessionAddress: string,
  taskId: string,
  txHash: string,
): Promise<TaskAcceptanceVerificationServiceResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }

  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const chainConfig = resolveFundingChainConfig();

  if (task.status === "ACCEPTED") {
    // The idempotent-replay success below must be scoped to the actual
    // accepting wallet (Codex review, T-805 round 2, P2): without this
    // check, ANY signed-in caller — not just the Agent who actually
    // accepted — could resubmit the (publicly visible, already-mined)
    // acceptance txHash and get back the same `{ ok: true, status:
    // 'ACCEPTED' }` success this task's real acceptor would, contradicting
    // this function's own "a stranger submitting someone else's txHash
    // gets mismatch" contract (its class-level doc comment above).
    if (normalizeAddress(sessionAddress) !== task.acceptedAgentAddress) {
      return { ok: false, reason: "conflict", currentStatus: task.status };
    }
    const existing = await findExistingAcceptanceForTask(
      pool,
      chainConfig.chainId,
      taskId,
      normalizedTxHash,
    );
    if (existing) {
      return { ok: true, status: "ACCEPTED", confirmations: existing.confirmations };
    }
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }
  if (task.status !== "OPEN") {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }

  const taskIdOnChain = deriveOnChainTaskId(task.id);
  const requiredConfirmations = resolveRequiredConfirmations();
  const normalizedSessionAddress = normalizeAddress(sessionAddress) as `0x${string}`;

  const verification = await verifyAcceptanceTransaction({
    rpc,
    txHash: normalizedTxHash,
    expectedChainId: chainConfig.chainId,
    trustedContractAddress: chainConfig.addresses.taskEscrow,
    requiredConfirmations,
    expected: {
      taskIdOnChain,
      agentAddress: normalizedSessionAddress,
      // T-806 (user's item #6, independent stake verification):
      // verifyAcceptanceTransaction reads STAKE_RATE_BPS from the contract
      // itself and cross-checks the on-chain event's `stake` against
      // `task.budget * rate / 10000` — task.budget is passed straight
      // through, the same decimal-string TaskRow field FundingIntent/
      // verifyFunding already use.
      budget: task.budget,
    },
  });

  if (!verification.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: verification.code,
      message: verification.message,
    };
  }

  const usage = await checkTransactionNotUsed(pool, chainConfig.chainId, normalizedTxHash, taskId);
  if (!usage.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: usage.code ?? "TRANSACTION_ALREADY_USED",
      message: usage.message ?? "transaction already bound to another task",
    };
  }

  // Same reorg-safety re-fetch `verifyFunding` performs and for the same
  // reason: recover `logIndex` via event-sync.ts's shared decoder (rather
  // than widening acceptance-tx-verifier.ts's already-reviewed return
  // shape), and re-confirm this second read is the SAME receipt (blockHash
  // equality) before trusting its logs for `chain_events`.
  let receipt: Awaited<ReturnType<ChainRpcClient["getTransactionReceipt"]>>;
  try {
    receipt = await rpc.getTransactionReceipt(normalizedTxHash);
  } catch (error) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
  if (!receipt || receipt.blockHash.toLowerCase() !== verification.blockHash.toLowerCase()) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt snapshot changed between verification and event recording (possible reorg)",
    };
  }
  const decodedEvents = decodeAcceptedEventsFromLogs(
    receipt.logs,
    chainConfig.addresses.taskEscrow,
  );
  const matchingEvent = decodedEvents.find(
    (candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase(),
  );
  if (!matchingEvent) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt logs were not available when recording the acceptance event",
    };
  }

  const acceptedAgentAddress = matchingEvent.event.agent.toLowerCase();
  // T-806: resolves which `agents.id` this acceptance belongs to via an
  // EXACT (task_id, accepting_address, nonce) match — `verification.nonce`
  // is decoded from the transaction's own calldata
  // (acceptance-tx-verifier.ts's `decodeAcceptTaskCalldata`), which is what
  // makes this precise rather than a guess. See `resolveAcceptingAgentId`'s
  // own doc comment (dispatch/repository.ts) for the full reasoning. Read
  // outside the transition's own transaction (a plain `pool` read, like
  // `verifyFunding`'s pre-transaction confirmations lookup) — the
  // authoritative check that this wallet was actually allowed to accept
  // already happened on-chain (the contract's own permit-signature check),
  // so this resolution racing a concurrent write is not a correctness gap
  // for THIS task's acceptance, only for which `agents.id` gets credited.
  const nonce = verification.event.nonce.toString();
  const agentId = await resolveAcceptingAgentId(pool, taskId, acceptedAgentAddress, nonce);
  if (!agentId) {
    // `null` means no OUTSTANDING acceptance_permits row exactly matches
    // (task_id, accepting_address, nonce) — `resolveAcceptingAgentId`
    // deliberately refuses to guess (no fallback of any kind, T-806
    // capsule), so the acceptance is not recorded rather than crediting a
    // possibly-wrong Agent.
    return {
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
      message: `could not resolve an outstanding permit for wallet ${acceptedAgentAddress}, nonce ${nonce}`,
    };
  }

  let transition;
  try {
    transition = await transitionTaskStatus(pool, {
      taskId,
      allowedFromStatuses: ["OPEN"],
      toStatus: "ACCEPTED",
      actor: normalizedSessionAddress,
      reason: "acceptance transaction verified",
      // design.md's F-706 note ("四者原子一致"): `accepted_agent_id` and
      // `accepted_agent_address` must both be written here, in the same
      // UPDATE as `status` — Feature 7's `countActiveTasksByAgentIds`
      // reads occupancy by `accepted_agent_id`, not by wallet address, so
      // omitting it would silently break that concurrent-capacity count.
      extraColumns: {
        accepted_agent_id: agentId,
        accepted_agent_address: acceptedAgentAddress,
        accepted_at: new Date(),
      },
      withinTransaction: async (client) => {
        const inserted = await insertChainTransaction(client, {
          txHash: normalizedTxHash,
          chainId: chainConfig.chainId,
          taskId,
          purpose: "ACCEPTANCE",
          status: "confirmed",
          confirmations: verification.confirmations,
        });
        if (!inserted) {
          // Same race handling as verifyFunding's identical branch: lost
          // the race for this (chainId, txHash) — find out who actually
          // owns it, inside this same transaction/client.
          const occupantTaskId = await findChainTransactionOwner(
            client,
            chainConfig.chainId,
            normalizedTxHash,
          );
          if (occupantTaskId !== taskId) {
            throw new TransactionAlreadyUsedByAnotherTaskError(occupantTaskId ?? "unknown");
          }
        }
        await insertChainEvent(client, {
          chainId: chainConfig.chainId,
          blockHash: verification.blockHash.toLowerCase(),
          transactionHash: normalizedTxHash,
          logIndex: matchingEvent.logIndex,
          eventName: "TaskAccepted",
          taskId,
          payload: {
            taskId: matchingEvent.event.taskId,
            agent: matchingEvent.event.agent,
            stake: matchingEvent.event.stake.toString(),
          },
        });
        // T-806 (user's items #1/#5): mark EXACTLY the one permit row the
        // on-chain transaction's calldata named (via its nonce) as
        // CONSUMED, and every OTHER outstanding permit for this task —
        // including this same agent's own other historical rows, and every
        // other candidate's — as INVALIDATED, atomically with the
        // transition itself. Both must happen together: "task status is
        // ACCEPTED" and "every non-winning permit is no longer usable" must
        // never be observably out of sync.
        await consumeAcceptancePermits(client, taskId, agentId, nonce, normalizedTxHash);
        await invalidateOtherOutstandingPermits(client, taskId, agentId, nonce);
      },
    });
  } catch (error) {
    if (error instanceof TransactionAlreadyUsedByAnotherTaskError) {
      return {
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
        message: `tx ${normalizedTxHash} on chain ${chainConfig.chainId} is already bound to task ${error.occupantTaskId}`,
      };
    }
    throw error;
  }

  if (transition.outcome === "not_found") {
    return { ok: false, reason: "not_found" };
  }
  if (transition.outcome === "conflict") {
    // Mirrors verifyFunding's overlapping-retry idempotency handling: a
    // concurrent verifyAcceptance call for the SAME task+txHash can
    // legitimately lose the row-lock race after already independently
    // verifying the same on-chain transaction — re-confirming via
    // findExistingAcceptanceForTask distinguishes that from a genuine
    // conflict (e.g. a different acceptance already won).
    if (transition.currentStatus === "ACCEPTED") {
      const existing = await findExistingAcceptanceForTask(
        pool,
        chainConfig.chainId,
        taskId,
        normalizedTxHash,
      );
      if (existing) {
        return { ok: true, status: "ACCEPTED", confirmations: existing.confirmations };
      }
    }
    return { ok: false, reason: "conflict", currentStatus: transition.currentStatus };
  }

  return { ok: true, status: "ACCEPTED", confirmations: verification.confirmations };
}

/**
 * T-905's idempotent-replay lookup: does a `chain_transactions` row already
 * exist for `(chainId, txHash)`, and does it belong to `taskId`? Mirrors
 * `findExistingAcceptanceForTask` exactly — `purpose: "RESULT_SUBMISSION"`
 * for the same reason that function scopes to `purpose: "ACCEPTANCE"`:
 * without it, this task's own `FUNDING`/`ACCEPTANCE` transaction hash would
 * satisfy this lookup, letting a caller resubmit an unrelated txHash as if
 * it were a valid result-submission replay.
 */
async function findExistingResultSubmissionForTask(
  pool: Pool,
  chainId: number,
  taskId: string,
  txHash: string,
): Promise<{ confirmations: number } | null> {
  const existing = await getChainTransactionByHash(pool, chainId, txHash, "RESULT_SUBMISSION");
  if (existing && existing.taskId === taskId) {
    return { confirmations: existing.confirmations };
  }
  return null;
}

export type TaskResultSubmissionVerificationServiceResult =
  | { ok: true; status: "SUBMITTED"; confirmations: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; currentStatus: TaskStatusValue }
  | { ok: false; reason: "chain_error"; code: ErrorCode; message: string };

/**
 * F-905/T-905: mirrors `verifyAcceptance`'s exact structure (idempotent
 * replay of an already-`SUBMITTED` task, otherwise independently RPC-verify
 * the `ResultSubmitted` event and atomically transition
 * `ACCEPTED`→`SUBMITTED` alongside the `chain_transactions`/`chain_events`
 * rows, all in one `transitionTaskStatus` transaction).
 *
 * The one deliberate difference from `verifyAcceptance`: no
 * `resolveAcceptingAgentId`/permit-consumption step — `submitResult`
 * (contracts/src/TaskEscrow.sol) already enforces `task.agent ==
 * msg.sender` on-chain, so there is no ambiguity to resolve the way
 * acceptance's "which of possibly several outstanding permits" question
 * required.
 *
 * `submitted_at`/`review_deadline` are written to `tasks` VERBATIM from
 * the decoded event's own fields (converted from on-chain unix-seconds to
 * `Date`, nothing else) — no `+ reviewWindow` arithmetic anywhere in this
 * function or any other in this codebase outside the contract itself
 * (design.md F-905/AC-908, this Feature's own repeated design decision).
 */
export async function verifyResultSubmission(
  pool: Pool,
  rpc: ChainRpcClient,
  sessionAddress: string,
  taskId: string,
  txHash: string,
): Promise<TaskResultSubmissionVerificationServiceResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }

  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const chainConfig = resolveFundingChainConfig();

  if (task.status === "SUBMITTED") {
    // Same reasoning as verifyAcceptance's identical guard (Codex review,
    // T-805 round 2, P2 precedent): the idempotent-replay success below
    // must be scoped to the actual submitting wallet, not any signed-in
    // caller who happens to know the (publicly visible, already-mined)
    // txHash.
    if (normalizeAddress(sessionAddress) !== task.acceptedAgentAddress) {
      return { ok: false, reason: "conflict", currentStatus: task.status };
    }
    const existing = await findExistingResultSubmissionForTask(
      pool,
      chainConfig.chainId,
      taskId,
      normalizedTxHash,
    );
    if (existing) {
      return { ok: true, status: "SUBMITTED", confirmations: existing.confirmations };
    }
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }
  if (task.status !== "ACCEPTED") {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }

  const taskIdOnChain = deriveOnChainTaskId(task.id);
  const requiredConfirmations = resolveRequiredConfirmations();
  const normalizedSessionAddress = normalizeAddress(sessionAddress) as `0x${string}`;

  const verification = await verifyResultSubmissionTransaction({
    rpc,
    txHash: normalizedTxHash,
    expectedChainId: chainConfig.chainId,
    trustedContractAddress: chainConfig.addresses.taskEscrow,
    requiredConfirmations,
    expected: {
      taskIdOnChain,
      agentAddress: normalizedSessionAddress,
    },
  });

  if (!verification.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: verification.code,
      message: verification.message,
    };
  }

  const usage = await checkTransactionNotUsed(pool, chainConfig.chainId, normalizedTxHash, taskId);
  if (!usage.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: usage.code ?? "TRANSACTION_ALREADY_USED",
      message: usage.message ?? "transaction already bound to another task",
    };
  }

  // Same reorg-safety re-fetch verifyAcceptance/verifyFunding perform and
  // for the same reason: recover `logIndex` via event-sync.ts's shared
  // decoder, and re-confirm this second read is the SAME receipt
  // (blockHash equality) before trusting its logs for `chain_events`.
  let receipt: Awaited<ReturnType<ChainRpcClient["getTransactionReceipt"]>>;
  try {
    receipt = await rpc.getTransactionReceipt(normalizedTxHash);
  } catch (error) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
  if (!receipt || receipt.blockHash.toLowerCase() !== verification.blockHash.toLowerCase()) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt snapshot changed between verification and event recording (possible reorg)",
    };
  }
  const decodedEvents = decodeResultSubmittedEventsFromLogs(
    receipt.logs,
    chainConfig.addresses.taskEscrow,
  );
  const matchingEvent = decodedEvents.find(
    (candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase(),
  );
  if (!matchingEvent) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt logs were not available when recording the result-submission event",
    };
  }

  let transition;
  try {
    transition = await transitionTaskStatus(pool, {
      taskId,
      allowedFromStatuses: ["ACCEPTED"],
      toStatus: "SUBMITTED",
      actor: normalizedSessionAddress,
      reason: "result submission transaction verified",
      extraColumns: {
        submitted_at: new Date(Number(matchingEvent.event.submittedAt) * 1000),
        review_deadline: new Date(Number(matchingEvent.event.reviewDeadline) * 1000),
      },
      withinTransaction: async (client) => {
        const inserted = await insertChainTransaction(client, {
          txHash: normalizedTxHash,
          chainId: chainConfig.chainId,
          taskId,
          purpose: "RESULT_SUBMISSION",
          status: "confirmed",
          confirmations: verification.confirmations,
        });
        if (!inserted) {
          const occupantTaskId = await findChainTransactionOwner(
            client,
            chainConfig.chainId,
            normalizedTxHash,
          );
          if (occupantTaskId !== taskId) {
            throw new TransactionAlreadyUsedByAnotherTaskError(occupantTaskId ?? "unknown");
          }
        }
        await insertChainEvent(client, {
          chainId: chainConfig.chainId,
          blockHash: verification.blockHash.toLowerCase(),
          transactionHash: normalizedTxHash,
          logIndex: matchingEvent.logIndex,
          eventName: "ResultSubmitted",
          taskId,
          payload: {
            taskId: matchingEvent.event.taskId,
            agent: matchingEvent.event.agent,
            resultHash: matchingEvent.event.resultHash,
            submittedAt: matchingEvent.event.submittedAt.toString(),
            reviewDeadline: matchingEvent.event.reviewDeadline.toString(),
          },
        });
      },
    });
  } catch (error) {
    if (error instanceof TransactionAlreadyUsedByAnotherTaskError) {
      return {
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
        message: `tx ${normalizedTxHash} on chain ${chainConfig.chainId} is already bound to task ${error.occupantTaskId}`,
      };
    }
    throw error;
  }

  if (transition.outcome === "not_found") {
    return { ok: false, reason: "not_found" };
  }
  if (transition.outcome === "conflict") {
    if (transition.currentStatus === "SUBMITTED") {
      const existing = await findExistingResultSubmissionForTask(
        pool,
        chainConfig.chainId,
        taskId,
        normalizedTxHash,
      );
      if (existing) {
        return { ok: true, status: "SUBMITTED", confirmations: existing.confirmations };
      }
    }
    return { ok: false, reason: "conflict", currentStatus: transition.currentStatus };
  }

  return { ok: true, status: "SUBMITTED", confirmations: verification.confirmations };
}

/**
 * T-1001's idempotent-replay lookup — mirrors
 * `findExistingResultSubmissionForTask` exactly, scoped to
 * `purpose: "SETTLEMENT"` for the same reason: without it, this task's
 * own `FUNDING`/`ACCEPTANCE`/`RESULT_SUBMISSION` transaction hash would
 * satisfy this lookup.
 */
async function findExistingSettlementForTask(
  pool: Pool,
  chainId: number,
  taskId: string,
  txHash: string,
): Promise<{ confirmations: number } | null> {
  const existing = await getChainTransactionByHash(pool, chainId, txHash, "SETTLEMENT");
  if (existing && existing.taskId === taskId) {
    return { confirmations: existing.confirmations };
  }
  return null;
}

/** What a settlement transaction's decoded event determines this call must
 * do — computed once, up front, from `verifySettlementTransaction`'s own
 * `decoded.kind` discriminant, so the rest of `verifySettlement` never has
 * a second place that maps event kind → allowed-from-status/target-status/
 * settlement-stats outcome. */
interface SettlementPlan {
  allowedFromStatuses: readonly TaskStatusValue[];
  toStatus: "RELEASED" | "REFUNDED";
  statsKind: SettlementEventKind;
  eventName: string;
}

function planForSettlementKind(
  kind: "RESULT_APPROVED" | "DELIVERY_TIMEOUT_CLAIMED" | "REVIEW_TIMEOUT_FINALIZED",
): SettlementPlan {
  switch (kind) {
    case "RESULT_APPROVED":
      return {
        allowedFromStatuses: ["SUBMITTED"],
        toStatus: "RELEASED",
        statsKind: "RESULT_APPROVED",
        eventName: "ResultApproved",
      };
    case "REVIEW_TIMEOUT_FINALIZED":
      return {
        allowedFromStatuses: ["SUBMITTED"],
        toStatus: "RELEASED",
        statsKind: "REVIEW_TIMEOUT_FINALIZED",
        eventName: "ReviewTimeoutFinalized",
      };
    case "DELIVERY_TIMEOUT_CLAIMED":
      return {
        allowedFromStatuses: ["ACCEPTED"],
        toStatus: "REFUNDED",
        statsKind: "DELIVERY_TIMEOUT_CLAIMED",
        eventName: "DeliveryTimeoutClaimed",
      };
  }
}

export type TaskSettlementVerificationServiceResult =
  | { ok: true; status: "RELEASED" | "REFUNDED"; confirmations: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; currentStatus: TaskStatusValue }
  | { ok: false; reason: "chain_error"; code: ErrorCode; message: string };

/**
 * F-1001/F-1002/T-1001: mirrors `verifyResultSubmission`'s exact structure
 * (idempotent replay of an already-terminal task, otherwise independently
 * RPC-verify the settlement event and atomically transition the task
 * alongside `chain_transactions`/`chain_events` and — the one genuinely
 * new step this function adds — `agents`' settlement-count columns, all
 * in one `transitionTaskStatus` transaction via `applySettlementStats`
 * called from `withinTransaction`).
 *
 * No caller-identity cross-check the way `verifyResultSubmission` checks
 * `agent == sessionAddress` — see `settlement-tx-verifier.ts`'s own header
 * comment for why: `approveResult`/`claimDeliveryTimeout` already enforce
 * `task.requester == msg.sender` on-chain, and `finalizeReviewTimeout` is
 * deliberately callable by anyone, so there is no "expected caller" this
 * function could validate that the contract hasn't already validated more
 * authoritatively.
 *
 * `DisputeResolved` is NOT handled here — T-1002's own scope, via a
 * separate `verifyDisputeResolution` sharing this same
 * `applySettlementStats` call for its own settlement-stats update (design.md:
 * "DisputeResolved 结算分支同样调用 settlement-stats.ts").
 */
export async function verifySettlement(
  pool: Pool,
  rpc: ChainRpcClient,
  taskId: string,
  txHash: string,
): Promise<TaskSettlementVerificationServiceResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }

  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const chainConfig = resolveFundingChainConfig();

  if (task.status === "RELEASED" || task.status === "REFUNDED") {
    const existing = await findExistingSettlementForTask(
      pool,
      chainConfig.chainId,
      taskId,
      normalizedTxHash,
    );
    if (existing) {
      return { ok: true, status: task.status, confirmations: existing.confirmations };
    }
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }
  if (task.status !== "ACCEPTED" && task.status !== "SUBMITTED") {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }
  if (!task.acceptedAgentId) {
    // Cannot happen for a real ACCEPTED/SUBMITTED task (acceptedAgentId is
    // written atomically with the OPEN->ACCEPTED transition), but guards
    // settlement-stats' own required, non-null input rather than silently
    // crediting nothing.
    return {
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
      message: `task ${taskId} has no acceptedAgentId despite status ${task.status}`,
    };
  }

  const taskIdOnChain = deriveOnChainTaskId(task.id);
  const requiredConfirmations = resolveRequiredConfirmations();

  const verification = await verifySettlementTransaction({
    rpc,
    txHash: normalizedTxHash,
    expectedChainId: chainConfig.chainId,
    trustedContractAddress: chainConfig.addresses.taskEscrow,
    requiredConfirmations,
    expectedTaskIdOnChain: taskIdOnChain,
  });
  if (!verification.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: verification.code,
      message: verification.message,
    };
  }

  const plan = planForSettlementKind(verification.decoded.kind);
  if (!plan.allowedFromStatuses.includes(task.status)) {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }

  const usage = await checkTransactionNotUsed(pool, chainConfig.chainId, normalizedTxHash, taskId);
  if (!usage.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: usage.code ?? "TRANSACTION_ALREADY_USED",
      message: usage.message ?? "transaction already bound to another task",
    };
  }

  // Same reorg-safety re-fetch verifyResultSubmission/verifyAcceptance/
  // verifyFunding perform and for the same reason.
  let receipt: Awaited<ReturnType<ChainRpcClient["getTransactionReceipt"]>>;
  try {
    receipt = await rpc.getTransactionReceipt(normalizedTxHash);
  } catch (error) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
  if (!receipt || receipt.blockHash.toLowerCase() !== verification.blockHash.toLowerCase()) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt snapshot changed between verification and event recording (possible reorg)",
    };
  }

  let logIndex: number | undefined;
  let payload: Record<string, string>;
  switch (verification.decoded.kind) {
    case "RESULT_APPROVED": {
      const matching = decodeResultApprovedEventsFromLogs(
        receipt.logs,
        chainConfig.addresses.taskEscrow,
      ).find((candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase());
      logIndex = matching?.logIndex;
      payload = matching
        ? {
            taskId: matching.event.taskId,
            agent: matching.event.agent,
            budget: matching.event.budget.toString(),
            stake: matching.event.stake.toString(),
          }
        : {};
      break;
    }
    case "DELIVERY_TIMEOUT_CLAIMED": {
      const matching = decodeDeliveryTimeoutClaimedEventsFromLogs(
        receipt.logs,
        chainConfig.addresses.taskEscrow,
      ).find((candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase());
      logIndex = matching?.logIndex;
      payload = matching
        ? {
            taskId: matching.event.taskId,
            requester: matching.event.requester,
            budget: matching.event.budget.toString(),
            stake: matching.event.stake.toString(),
          }
        : {};
      break;
    }
    case "REVIEW_TIMEOUT_FINALIZED": {
      const matching = decodeReviewTimeoutFinalizedEventsFromLogs(
        receipt.logs,
        chainConfig.addresses.taskEscrow,
      ).find((candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase());
      logIndex = matching?.logIndex;
      payload = matching
        ? {
            taskId: matching.event.taskId,
            agent: matching.event.agent,
            budget: matching.event.budget.toString(),
            stake: matching.event.stake.toString(),
          }
        : {};
      break;
    }
  }
  if (logIndex === undefined) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt logs were not available when recording the settlement event",
    };
  }

  const acceptedAgentId = task.acceptedAgentId;
  let transition;
  try {
    transition = await transitionTaskStatus(pool, {
      taskId,
      allowedFromStatuses: plan.allowedFromStatuses,
      toStatus: plan.toStatus,
      actor: "system:settlement-verification",
      reason: `${plan.eventName} transaction verified`,
      withinTransaction: async (client) => {
        const inserted = await insertChainTransaction(client, {
          txHash: normalizedTxHash,
          chainId: chainConfig.chainId,
          taskId,
          purpose: "SETTLEMENT",
          status: "confirmed",
          confirmations: verification.confirmations,
        });
        if (!inserted) {
          const occupantTaskId = await findChainTransactionOwner(
            client,
            chainConfig.chainId,
            normalizedTxHash,
          );
          if (occupantTaskId !== taskId) {
            throw new TransactionAlreadyUsedByAnotherTaskError(occupantTaskId ?? "unknown");
          }
        }
        await insertChainEvent(client, {
          chainId: chainConfig.chainId,
          blockHash: verification.blockHash.toLowerCase(),
          transactionHash: normalizedTxHash,
          logIndex,
          eventName: plan.eventName,
          taskId,
          payload,
        });
        await applySettlementStats(client, acceptedAgentId, plan.statsKind);
      },
    });
  } catch (error) {
    if (error instanceof TransactionAlreadyUsedByAnotherTaskError) {
      return {
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
        message: `tx ${normalizedTxHash} on chain ${chainConfig.chainId} is already bound to task ${error.occupantTaskId}`,
      };
    }
    throw error;
  }

  if (transition.outcome === "not_found") {
    return { ok: false, reason: "not_found" };
  }
  if (transition.outcome === "conflict") {
    if (transition.currentStatus === "RELEASED" || transition.currentStatus === "REFUNDED") {
      const existing = await findExistingSettlementForTask(
        pool,
        chainConfig.chainId,
        taskId,
        normalizedTxHash,
      );
      if (existing) {
        return {
          ok: true,
          status: transition.currentStatus,
          confirmations: existing.confirmations,
        };
      }
    }
    return { ok: false, reason: "conflict", currentStatus: transition.currentStatus };
  }

  return { ok: true, status: plan.toStatus, confirmations: verification.confirmations };
}

/**
 * T-1002's idempotent-replay lookup for `openDispute` — mirrors
 * `findExistingSettlementForTask` exactly, scoped to
 * `purpose: "DISPUTE_OPEN"`.
 */
async function findExistingDisputeOpenForTask(
  pool: Pool,
  chainId: number,
  taskId: string,
  txHash: string,
): Promise<{ confirmations: number } | null> {
  const existing = await getChainTransactionByHash(pool, chainId, txHash, "DISPUTE_OPEN");
  if (existing && existing.taskId === taskId) {
    return { confirmations: existing.confirmations };
  }
  return null;
}

export type TaskDisputeOpenVerificationServiceResult =
  | { ok: true; status: "DISPUTED"; confirmations: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; currentStatus: TaskStatusValue }
  | { ok: false; reason: "chain_error"; code: ErrorCode; message: string };

/**
 * F-1003/T-1002: verifies a real, confirmed `openDispute` transaction and
 * atomically transitions `SUBMITTED`→`DISPUTED`. Requires an `OPEN`
 * dispute row (`disputes/repository.ts`'s `getOpenDisputeForTask`) to
 * already exist for this task — `POST /tasks/:taskId/disputes`
 * (disputes/routes.ts) is the prerequisite off-chain step design.md's
 * F-1003 describes; without a recorded dispute, an arbitrator would have
 * no reason/evidence to review even if the on-chain event is real, so
 * this function refuses to transition the task at all in that case rather
 * than accepting a DISPUTED task with nothing behind it.
 */
export async function verifyDisputeOpen(
  pool: Pool,
  rpc: ChainRpcClient,
  taskId: string,
  txHash: string,
): Promise<TaskDisputeOpenVerificationServiceResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }

  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const chainConfig = resolveFundingChainConfig();

  if (task.status === "DISPUTED") {
    const existing = await findExistingDisputeOpenForTask(
      pool,
      chainConfig.chainId,
      taskId,
      normalizedTxHash,
    );
    if (existing) {
      return { ok: true, status: "DISPUTED", confirmations: existing.confirmations };
    }
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }
  if (task.status !== "SUBMITTED") {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }

  const openDispute = await getOpenDisputeForTask(pool, taskId);
  if (!openDispute) {
    return {
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
      message: "no open dispute record found for this task — call POST .../disputes first",
    };
  }

  const taskIdOnChain = deriveOnChainTaskId(task.id);
  const requiredConfirmations = resolveRequiredConfirmations();

  const verification = await verifyDisputeOpenTransaction({
    rpc,
    txHash: normalizedTxHash,
    expectedChainId: chainConfig.chainId,
    trustedContractAddress: chainConfig.addresses.taskEscrow,
    requiredConfirmations,
    expectedTaskIdOnChain: taskIdOnChain,
    expectedEvidenceHash: openDispute.evidenceHash,
  });
  if (!verification.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: verification.code,
      message: verification.message,
    };
  }

  const usage = await checkTransactionNotUsed(pool, chainConfig.chainId, normalizedTxHash, taskId);
  if (!usage.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: usage.code ?? "TRANSACTION_ALREADY_USED",
      message: usage.message ?? "transaction already bound to another task",
    };
  }

  let receipt: Awaited<ReturnType<ChainRpcClient["getTransactionReceipt"]>>;
  try {
    receipt = await rpc.getTransactionReceipt(normalizedTxHash);
  } catch (error) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
  if (!receipt || receipt.blockHash.toLowerCase() !== verification.blockHash.toLowerCase()) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt snapshot changed between verification and event recording (possible reorg)",
    };
  }
  const matchingEvent = decodeDisputeOpenedEventsFromLogs(
    receipt.logs,
    chainConfig.addresses.taskEscrow,
  ).find((candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase());
  if (!matchingEvent) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt logs were not available when recording the DisputeOpened event",
    };
  }

  let transition;
  try {
    transition = await transitionTaskStatus(pool, {
      taskId,
      allowedFromStatuses: ["SUBMITTED"],
      toStatus: "DISPUTED",
      actor: "system:dispute-open-verification",
      reason: "DisputeOpened transaction verified",
      withinTransaction: async (client) => {
        const inserted = await insertChainTransaction(client, {
          txHash: normalizedTxHash,
          chainId: chainConfig.chainId,
          taskId,
          purpose: "DISPUTE_OPEN",
          status: "confirmed",
          confirmations: verification.confirmations,
        });
        if (!inserted) {
          const occupantTaskId = await findChainTransactionOwner(
            client,
            chainConfig.chainId,
            normalizedTxHash,
          );
          if (occupantTaskId !== taskId) {
            throw new TransactionAlreadyUsedByAnotherTaskError(occupantTaskId ?? "unknown");
          }
        }
        await insertChainEvent(client, {
          chainId: chainConfig.chainId,
          blockHash: verification.blockHash.toLowerCase(),
          transactionHash: normalizedTxHash,
          logIndex: matchingEvent.logIndex,
          eventName: "DisputeOpened",
          taskId,
          payload: {
            taskId: matchingEvent.event.taskId,
            requester: matchingEvent.event.requester,
            disputeEvidenceHash: matchingEvent.event.disputeEvidenceHash,
          },
        });
      },
    });
  } catch (error) {
    if (error instanceof TransactionAlreadyUsedByAnotherTaskError) {
      return {
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
        message: `tx ${normalizedTxHash} on chain ${chainConfig.chainId} is already bound to task ${error.occupantTaskId}`,
      };
    }
    throw error;
  }

  if (transition.outcome === "not_found") {
    return { ok: false, reason: "not_found" };
  }
  if (transition.outcome === "conflict") {
    if (transition.currentStatus === "DISPUTED") {
      const existing = await findExistingDisputeOpenForTask(
        pool,
        chainConfig.chainId,
        taskId,
        normalizedTxHash,
      );
      if (existing) {
        return { ok: true, status: "DISPUTED", confirmations: existing.confirmations };
      }
    }
    return { ok: false, reason: "conflict", currentStatus: transition.currentStatus };
  }

  return { ok: true, status: "DISPUTED", confirmations: verification.confirmations };
}

/**
 * T-1002's idempotent-replay lookup for `resolveDispute` — mirrors
 * `findExistingSettlementForTask`, scoped to `purpose: "DISPUTE_RESOLVE"`.
 */
async function findExistingDisputeResolveForTask(
  pool: Pool,
  chainId: number,
  taskId: string,
  txHash: string,
): Promise<{ confirmations: number } | null> {
  const existing = await getChainTransactionByHash(pool, chainId, txHash, "DISPUTE_RESOLVE");
  if (existing && existing.taskId === taskId) {
    return { confirmations: existing.confirmations };
  }
  return null;
}

export type TaskDisputeResolveVerificationServiceResult =
  | { ok: true; status: "RELEASED" | "REFUNDED"; confirmations: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; currentStatus: TaskStatusValue }
  | { ok: false; reason: "chain_error"; code: ErrorCode; message: string };

/**
 * F-1004/T-1002: verifies a real, confirmed `resolveDispute` transaction
 * and atomically transitions `DISPUTED`→`RELEASED`/`REFUNDED` (per the
 * decoded `supportAgent` flag), updates `settlement-stats.ts`'s counts
 * (design.md: "DisputeResolved 结算分支同样调用 settlement-stats.ts"),
 * resolves the `disputes` row, and writes a PRD §15.1 `audit_logs` entry —
 * all inside the same transaction, so none of these can ever be
 * observably out of sync with each other.
 *
 * `resolvedBy` for both the `disputes` row and the audit log is the
 * verified transaction's own signer (`verifyDisputeResolveTransaction`'s
 * `resolvedBy`, read independently via `rpc.getTransaction`) — NOT the
 * identity of whoever called this HTTP endpoint. `resolveDispute` enforces
 * `ARBITRATOR_ROLE` on-chain, but the caller of this verification endpoint
 * is just whichever authenticated session happened to report the txHash;
 * trusting that identity for the audit trail would let any logged-in user
 * report a real, already-mined transaction and get themselves recorded as
 * the arbitrator (Codex review, T-1002 round 1, P1).
 */
export async function verifyDisputeResolution(
  pool: Pool,
  rpc: ChainRpcClient,
  taskId: string,
  txHash: string,
): Promise<TaskDisputeResolveVerificationServiceResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "not_found" };
  }

  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const chainConfig = resolveFundingChainConfig();

  if (task.status === "RELEASED" || task.status === "REFUNDED") {
    const existing = await findExistingDisputeResolveForTask(
      pool,
      chainConfig.chainId,
      taskId,
      normalizedTxHash,
    );
    if (existing) {
      return { ok: true, status: task.status, confirmations: existing.confirmations };
    }
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }
  if (task.status !== "DISPUTED") {
    return { ok: false, reason: "conflict", currentStatus: task.status };
  }
  if (!task.acceptedAgentId) {
    return {
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
      message: `task ${taskId} has no acceptedAgentId despite status ${task.status}`,
    };
  }

  const taskIdOnChain = deriveOnChainTaskId(task.id);
  const requiredConfirmations = resolveRequiredConfirmations();

  const verification = await verifyDisputeResolveTransaction({
    rpc,
    txHash: normalizedTxHash,
    expectedChainId: chainConfig.chainId,
    trustedContractAddress: chainConfig.addresses.taskEscrow,
    requiredConfirmations,
    expectedTaskIdOnChain: taskIdOnChain,
  });
  if (!verification.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: verification.code,
      message: verification.message,
    };
  }

  const usage = await checkTransactionNotUsed(pool, chainConfig.chainId, normalizedTxHash, taskId);
  if (!usage.ok) {
    return {
      ok: false,
      reason: "chain_error",
      code: usage.code ?? "TRANSACTION_ALREADY_USED",
      message: usage.message ?? "transaction already bound to another task",
    };
  }

  let receipt: Awaited<ReturnType<ChainRpcClient["getTransactionReceipt"]>>;
  try {
    receipt = await rpc.getTransactionReceipt(normalizedTxHash);
  } catch (error) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
  if (!receipt || receipt.blockHash.toLowerCase() !== verification.blockHash.toLowerCase()) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt snapshot changed between verification and event recording (possible reorg)",
    };
  }
  const matchingEvent = decodeDisputeResolvedEventsFromLogs(
    receipt.logs,
    chainConfig.addresses.taskEscrow,
  ).find((candidate) => candidate.event.taskId.toLowerCase() === taskIdOnChain.toLowerCase());
  if (!matchingEvent) {
    return {
      ok: false,
      reason: "chain_error",
      code: "RPC_TEMPORARILY_UNAVAILABLE",
      message: "receipt logs were not available when recording the DisputeResolved event",
    };
  }

  const supportAgent = matchingEvent.event.supportAgent;
  const toStatus: "RELEASED" | "REFUNDED" = supportAgent ? "RELEASED" : "REFUNDED";
  const statsKind: SettlementEventKind = supportAgent
    ? "DISPUTE_RESOLVED_SUPPORT_AGENT"
    : "DISPUTE_RESOLVED_SUPPORT_REQUESTER";
  const resolution: "SUPPORT_AGENT" | "SUPPORT_REQUESTER" = supportAgent
    ? "SUPPORT_AGENT"
    : "SUPPORT_REQUESTER";
  const acceptedAgentId = task.acceptedAgentId;
  const resolvedByAddress = verification.resolvedBy.toLowerCase();

  let transition;
  try {
    transition = await transitionTaskStatus(pool, {
      taskId,
      allowedFromStatuses: ["DISPUTED"],
      toStatus,
      actor: "system:dispute-resolve-verification",
      reason: "DisputeResolved transaction verified",
      withinTransaction: async (client) => {
        const inserted = await insertChainTransaction(client, {
          txHash: normalizedTxHash,
          chainId: chainConfig.chainId,
          taskId,
          purpose: "DISPUTE_RESOLVE",
          status: "confirmed",
          confirmations: verification.confirmations,
        });
        if (!inserted) {
          const occupantTaskId = await findChainTransactionOwner(
            client,
            chainConfig.chainId,
            normalizedTxHash,
          );
          if (occupantTaskId !== taskId) {
            throw new TransactionAlreadyUsedByAnotherTaskError(occupantTaskId ?? "unknown");
          }
        }
        await insertChainEvent(client, {
          chainId: chainConfig.chainId,
          blockHash: verification.blockHash.toLowerCase(),
          transactionHash: normalizedTxHash,
          logIndex: matchingEvent.logIndex,
          eventName: "DisputeResolved",
          taskId,
          payload: {
            taskId: matchingEvent.event.taskId,
            supportAgent: String(matchingEvent.event.supportAgent),
          },
        });
        await applySettlementStats(client, acceptedAgentId, statsKind);
        // `disputes.resolved_by` FK-references `users(address)`; the
        // arbitrator's on-chain address may never have signed into this
        // backend before, so it must be upserted here (not merely looked
        // up) before resolveDisputeRow's UPDATE can reference it.
        await client.query(
          `INSERT INTO users (address) VALUES ($1) ON CONFLICT (address) DO NOTHING`,
          [resolvedByAddress],
        );
        const disputeResolved = await resolveDisputeRow(
          client,
          taskId,
          resolution,
          resolvedByAddress,
        );
        if (!disputeResolved) {
          throw new DisputeRowNotOpenError(taskId);
        }
        await insertAuditLog(client, {
          actorAddress: resolvedByAddress,
          action: "DISPUTE_RESOLVED",
          taskId,
          reason: `resolveDispute(supportAgent=${supportAgent})`,
          txHash: normalizedTxHash,
        });
      },
    });
  } catch (error) {
    if (error instanceof TransactionAlreadyUsedByAnotherTaskError) {
      return {
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
        message: `tx ${normalizedTxHash} on chain ${chainConfig.chainId} is already bound to task ${error.occupantTaskId}`,
      };
    }
    if (error instanceof DisputeRowNotOpenError) {
      return {
        ok: false,
        reason: "chain_error",
        code: "FUNDING_EVENT_MISMATCH",
        message: error.message,
      };
    }
    throw error;
  }

  if (transition.outcome === "not_found") {
    return { ok: false, reason: "not_found" };
  }
  if (transition.outcome === "conflict") {
    if (transition.currentStatus === "RELEASED" || transition.currentStatus === "REFUNDED") {
      const existing = await findExistingDisputeResolveForTask(
        pool,
        chainConfig.chainId,
        taskId,
        normalizedTxHash,
      );
      if (existing) {
        return {
          ok: true,
          status: transition.currentStatus,
          confirmations: existing.confirmations,
        };
      }
    }
    return { ok: false, reason: "conflict", currentStatus: transition.currentStatus };
  }

  return { ok: true, status: toStatus, confirmations: verification.confirmations };
}
