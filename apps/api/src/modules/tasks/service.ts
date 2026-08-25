import { resolveChainConfig, type ChainConfig, type ErrorCode } from "@agent-market/domain";
import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import { verifyAcceptanceTransaction } from "../chain/acceptance-tx-verifier.js";
import { decodeAcceptedEventsFromLogs, decodeFundedEventsFromLogs } from "../chain/event-sync.js";
import type { ChainRpcClient } from "../chain/rpc.client.js";
import { checkTransactionNotUsed, verifyFundingTransaction } from "../chain/tx-verifier.js";
import {
  consumeAcceptancePermits,
  invalidateOtherOutstandingPermits,
  resolveAcceptingAgentId,
} from "../dispatch/repository.js";
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
 * F-601/AC-601: creates a `DRAFT` task owned by `sessionAddress` (the
 * caller's verified session address — routes.ts gets this from
 * `request.address`, never from request body input, mirroring agents/
 * service.ts's `createAgent`).
 *
 * Idempotency (F-601 "支持客户端幂等键" / the capsule's core
 * requirement): when `idempotencyKey` is supplied, an existing task created
 * by the same requester with the same key is returned as-is instead of
 * inserting a duplicate. Two request phases both need this check:
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
 *    the same success response the winner got.
 */
export async function createDraft(
  pool: Pool,
  sessionAddress: string,
  input: CreateDraftInput,
  idempotencyKey: string | null,
): Promise<TaskRow> {
  const requesterAddress = normalizeAddress(sessionAddress);
  const skillTags = [...new Set(input.skillTags)];
  const token = resolveYdTokenAddress();

  if (idempotencyKey) {
    const existing = await findDraftByIdempotencyKey(pool, requesterAddress, idempotencyKey);
    if (existing) {
      return existing;
    }
  }

  try {
    return await insertTaskDraft(pool, {
      requesterAddress,
      category: input.category,
      title: input.title,
      description: input.description,
      budget: input.budget,
      token,
      deliveryDeadline: new Date(input.deliveryDeadline),
      idempotencyKey,
      skillTags,
    });
  } catch (error) {
    if (idempotencyKey && isUniqueViolation(error)) {
      const existing = await findDraftByIdempotencyKey(pool, requesterAddress, idempotencyKey);
      if (existing) {
        return existing;
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
function resolveRequiredConfirmations(): number {
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
