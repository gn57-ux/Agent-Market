import type { Pool } from "pg";
import type { CreateDagInput } from "./schema.js";
import { validateTopology, type TopologyValidationResult } from "./topology.js";
import {
  insertDag,
  activateDag as activateDagAtomic,
  advanceDagNodes as advanceDagNodesAtomic,
  retryDagNode as retryDagNodeAtomic,
  manualTakeoverDagNode as manualTakeoverDagNodeAtomic,
  selectDagNodeResult as selectDagNodeResultAtomic,
  withLockedActiveDagNode,
  getDagDetail as getDagDetailAtomic,
  type DagRow,
  type ActivatedTask,
  type DagDetailRow,
} from "./repository.js";
import { embedTaskOnSave } from "../embeddings/embed-on-save.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import { isAdminAddress } from "../admin/repository.js";
import {
  verifyCancellation,
  type TaskCancellationVerificationServiceResult,
} from "../tasks/service.js";
import type { ChainRpcClient } from "../chain/rpc.client.js";

export type CreateDagResult =
  | { ok: true; dag: DagRow }
  | { ok: false; reason: "TOPOLOGY_INVALID"; detail: string }
  | { ok: false; reason: "BUDGET_MISMATCH"; detail: string };

/**
 * F-1701: orchestrates the two request-level checks design.md's interface
 * contract requires BEFORE anything is persisted (校验DAG无环、汇总节点前置
 * 存在、子预算之和与声明总预算一致) — topology.ts's pure graph check, then
 * this function's own budget-sum check — and only calls repository.ts's
 * `insertDag` once both pass. Keeping both checks here (not inside
 * repository.ts) means a rejected request never opens a transaction at
 * all, and topology.ts stays testable without a database (see its own doc
 * comment).
 */
export async function createDag(
  pool: Pool,
  requesterAddress: string,
  input: CreateDagInput,
): Promise<CreateDagResult> {
  const topologyResult: TopologyValidationResult = validateTopology(
    input.nodes.map((node) => ({ key: node.key, role: node.role, dependsOn: node.dependsOn })),
  );
  if (!topologyResult.ok) {
    return { ok: false, reason: "TOPOLOGY_INVALID", detail: topologyResult.detail };
  }

  const declaredTotal = BigInt(input.totalBudget);
  const subBudgetSum = input.nodes.reduce((sum, node) => sum + BigInt(node.subBudget), 0n);
  if (subBudgetSum !== declaredTotal) {
    return {
      ok: false,
      reason: "BUDGET_MISMATCH",
      detail: `节点子预算之和（${subBudgetSum.toString()}）与声明的总预算（${declaredTotal.toString()}）不一致`,
    };
  }

  const dag = await insertDag(pool, requesterAddress, input);
  return { ok: true, dag };
}

// Same convention as tasks/service.ts's own resolveYdTokenAddress (each
// module keeps its own copy — established convention, see funds/schema.ts
// ETH_ADDRESS_SCHEMA's doc comment for the general pattern this follows).
const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_YD_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
function resolveYdTokenAddress(): string {
  const raw = process.env.YD_TOKEN_ADDRESS;
  if (raw && HEX_ADDRESS_PATTERN.test(raw)) return raw.toLowerCase();
  return DEFAULT_YD_TOKEN_ADDRESS;
}

/**
 * N4 real finding (P2): a DAG-activated task's real `tasks` row is
 * created by a direct INSERT inside repository.ts's own transaction, not
 * through tasks/routes.ts's `POST /tasks/drafts`/`PATCH .../draft` — both
 * of which fire `embedTaskOnSave` right after their own write. Without
 * this call, a DAG-originated task would never get a `task_embeddings`
 * row, silently falling out of Feature 13's vector-recall-backed
 * matching. Fire-and-forget (`.catch(() => {})`), same as both existing
 * call sites in tasks/routes.ts — a failed embed must never fail the
 * activation/advancement call it rides along with, and is called AFTER
 * the caller's own `await` on the atomic repository function, i.e. after
 * that transaction has already committed (never inside it — embedding
 * calls a real Ollama HTTP endpoint, which has no place inside a
 * Postgres row lock's critical section).
 */
function embedActivatedTasks(pool: Pool, activatedTasks: ActivatedTask[]): void {
  for (const task of activatedTasks) {
    void embedTaskOnSave(pool, {
      id: task.taskId,
      description: task.description,
      expertType: task.expertType,
      category: task.category,
      skillTags: task.skillTags,
    }).catch(() => {});
  }
}

export type ActivateDagResult =
  | { ok: true; activatedNodeIds: string[] }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "FORBIDDEN" }
  | { ok: false; reason: "NOT_DRAFT"; detail: string }
  | { ok: false; reason: "NOTHING_READY"; detail: string }
  | { ok: false; reason: "NODE_DEADLINE_EXPIRED"; detail: string }
  | { ok: false; reason: "NODE_MISSING_ACTIVATION_FIELDS"; detail: string };

/**
 * F-1701/design.md 接口契约 (T-1702): `POST /dags/:dagId/activate` — creates
 * a real `tasks` row (via repository.ts's `activateDag`, reusing `tasks`'s
 * exact schema, not a parallel one) for every node with zero declared
 * preconditions, then marks the DAG `ACTIVE`. Nodes with preconditions
 * stay `PENDING`, untouched — advancing them once their preconditions are
 * satisfied is T-1703's own responsibility (node state advancement), not
 * this function's.
 *
 * This function does NOT perform or wait for any on-chain transaction —
 * design.md 决策 1's "延迟锁定" model means the requester still has to
 * perform their own real `approve`+`createTask` for each newly-created
 * task via the EXISTING `POST /tasks/:taskId/funding-verifications`
 * endpoint (Feature 6, unchanged) once this call returns; this function's
 * job ends at "the task row now exists and is linked to its node."
 *
 * All the actual validation (ownership, DRAFT status, readiness, deadline
 * freshness) happens inside repository.ts's `activateDag`, under a single
 * row lock — see that function's own doc comment for why (N4 round-1
 * findings: this used to be split across an unlocked pre-read here plus a
 * separate write, which raced under concurrent activation). This function
 * is now token resolution + embedding trigger (see `embedActivatedTasks`)
 * + translating that function's outcome into this module's own result
 * shape/Chinese error messages.
 */
export async function activateDag(
  pool: Pool,
  requesterAddress: string,
  dagId: string,
): Promise<ActivateDagResult> {
  const token = resolveYdTokenAddress();
  const outcome = await activateDagAtomic(pool, dagId, requesterAddress, token);

  switch (outcome.outcome) {
    case "not_found":
      return { ok: false, reason: "NOT_FOUND" };
    case "forbidden":
      return { ok: false, reason: "FORBIDDEN" };
    case "not_draft":
      return {
        ok: false,
        reason: "NOT_DRAFT",
        detail: `DAG 当前状态为 ${outcome.currentStatus}，只有 DRAFT 状态的 DAG 可以被激活`,
      };
    case "nothing_ready":
      return {
        ok: false,
        reason: "NOTHING_READY",
        detail: "没有任何无前置依赖的节点可以激活——请检查 DAG 拓扑是否至少有一个入口节点",
      };
    case "node_deadline_expired":
      return {
        ok: false,
        reason: "NODE_DEADLINE_EXPIRED",
        detail: `以下节点的截止时间已过期，无法激活：${outcome.nodeIds.join(", ")}`,
      };
    case "node_missing_activation_fields":
      return {
        ok: false,
        reason: "NODE_MISSING_ACTIVATION_FIELDS",
        detail: `以下节点缺少标题或截止时间，无法激活（可能是本迁移之前创建的节点）：${outcome.nodeIds.join(", ")}`,
      };
    case "activated":
      embedActivatedTasks(pool, outcome.activatedTasks);
      return { ok: true, activatedNodeIds: outcome.activatedTasks.map((task) => task.nodeId) };
  }
}

export type AdvanceDagResult =
  | {
      ok: true;
      syncedNodeIds: string[];
      /** T-1704: nodes whose overdue-Agent (REFUNDED) task was replaced
       * with a fresh real task this tick — see repository.ts's
       * `advanceDagNodes` doc comment for the design decision. */
      rematchedNodeIds: string[];
      activatedNodeIds: string[];
      dagCompleted: boolean;
      /** N4 round-2 P2 fix: a blocked downstream node no longer aborts the
       * whole tick — `syncedNodeIds`/`dagCompleted` above are still real,
       * committed progress even when this is set. See repository.ts's
       * `advanceDagNodes` doc comment. */
      blocked?: {
        reason: "NODE_DEADLINE_EXPIRED" | "NODE_MISSING_ACTIVATION_FIELDS";
        detail: string;
      };
    }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "NOT_ACTIVE"; detail: string };

/**
 * F-1701/design.md 接口契约 (T-1703): thin token-resolution wrapper around
 * repository.ts's `advanceDagNodes` — same role this module's
 * `activateDag` plays for `activateDagAtomic`, including the same
 * post-commit `embedActivatedTasks` call for any node this tick newly
 * activated. Not exposed as an HTTP route (design.md: node advancement is
 * "非直接暴露给前端的公共写入端点") — real callers are `dag-poller.ts`'s
 * background loop (`server.ts`, standing in for Feature 18's not-yet-built
 * event consumer) and this module's own tests (see repository.ts's own
 * doc comment on `advanceDagNodes` for the full "临时同步轮询" rationale).
 */
export async function advanceDag(pool: Pool, dagId: string): Promise<AdvanceDagResult> {
  const token = resolveYdTokenAddress();
  const outcome = await advanceDagNodesAtomic(pool, dagId, token);

  switch (outcome.outcome) {
    case "not_found":
      return { ok: false, reason: "NOT_FOUND" };
    case "not_active":
      return {
        ok: false,
        reason: "NOT_ACTIVE",
        detail: `DAG 当前状态为 ${outcome.currentStatus}，只有 ACTIVE 状态的 DAG 可以推进节点`,
      };
    case "advanced":
      embedActivatedTasks(pool, outcome.activatedTasks);
      return {
        ok: true,
        syncedNodeIds: outcome.syncedNodeIds,
        rematchedNodeIds: outcome.rematchedNodeIds,
        activatedNodeIds: outcome.activatedTasks.map((task) => task.nodeId),
        dagCompleted: outcome.dagCompleted,
        ...(outcome.blocked
          ? {
              blocked: {
                reason:
                  outcome.blocked.reason === "node_deadline_expired"
                    ? ("NODE_DEADLINE_EXPIRED" as const)
                    : ("NODE_MISSING_ACTIVATION_FIELDS" as const),
                detail: `以下节点无法推进：${outcome.blocked.nodeIds.join(", ")}（${outcome.blocked.reason}）`,
              },
            }
          : {}),
      };
  }
}

export type RetryDagNodeResult =
  | { ok: true; activatedNodeId: string; taskId: string }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "FORBIDDEN" }
  | { ok: false; reason: "NOT_RETRYABLE"; detail: string }
  | { ok: false; reason: "DAG_NOT_RETRYABLE"; detail: string };

/**
 * F-1705 "重试": thin token-resolution wrapper around repository.ts's
 * `retryDagNode`, same role this module's `activateDag`/`advanceDag` play
 * for their own atomic counterparts — including the same post-commit
 * `embedActivatedTasks` call (a retry creates a real new `tasks` row, same
 * as activation/rematch, and must not silently skip Feature 13's
 * embedding pipeline the way the original DAG-activation gap did).
 */
export async function retryDagNode(
  pool: Pool,
  requesterAddress: string,
  dagId: string,
  nodeId: string,
): Promise<RetryDagNodeResult> {
  const token = resolveYdTokenAddress();
  const outcome = await retryDagNodeAtomic(pool, dagId, nodeId, requesterAddress, token);

  switch (outcome.outcome) {
    case "not_found":
      return { ok: false, reason: "NOT_FOUND" };
    case "forbidden":
      return { ok: false, reason: "FORBIDDEN" };
    case "not_retryable":
      return {
        ok: false,
        reason: "NOT_RETRYABLE",
        detail: `节点当前状态为 ${outcome.currentStatus}，只有终止失败（FAILED）且原任务已 REFUNDED/CANCELLED 的节点可以重试`,
      };
    case "dag_not_retryable":
      return {
        ok: false,
        reason: "DAG_NOT_RETRYABLE",
        detail: `DAG 当前状态为 ${outcome.currentStatus}，只有 ACTIVE 或 COMPLETED 状态的 DAG 可以重试节点`,
      };
    case "retried":
      embedActivatedTasks(pool, [outcome.activatedTask]);
      return {
        ok: true,
        activatedNodeId: outcome.activatedTask.nodeId,
        taskId: outcome.activatedTask.taskId,
      };
  }
}

export type ManualTakeoverDagNodeResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "FORBIDDEN" }
  | { ok: false; reason: "NOT_PAUSABLE"; detail: string };

/**
 * F-1705 "人工接管": thin wrapper around repository.ts's
 * `manualTakeoverDagNode` — no token resolution needed (no chain
 * interaction at all, see that function's own doc comment), so this is
 * purely outcome-shape translation, matching this module's established
 * pattern for every other node-control result.
 */
export async function manualTakeoverDagNode(
  pool: Pool,
  requesterAddress: string,
  dagId: string,
  nodeId: string,
): Promise<ManualTakeoverDagNodeResult> {
  const outcome = await manualTakeoverDagNodeAtomic(pool, dagId, nodeId, requesterAddress);

  switch (outcome.outcome) {
    case "not_found":
      return { ok: false, reason: "NOT_FOUND" };
    case "forbidden":
      return { ok: false, reason: "FORBIDDEN" };
    case "not_pausable":
      return {
        ok: false,
        reason: "NOT_PAUSABLE",
        detail: `节点当前状态为 ${outcome.currentStatus}，只有 PENDING/TASK_ACTIVE 状态的节点可以被人工接管暂停`,
      };
    case "paused":
      return { ok: true };
  }
}

export type CancelDagNodeResult =
  | { ok: true; status: "CANCELLED"; confirmations: number }
  | { ok: false; reason: "DAG_NOT_FOUND" }
  | { ok: false; reason: "FORBIDDEN" }
  | { ok: false; reason: "NODE_NOT_FOUND" }
  | { ok: false; reason: "NODE_NOT_ACTIVE" }
  | Extract<TaskCancellationVerificationServiceResult, { ok: false; reason: "not_found" }>
  | Extract<TaskCancellationVerificationServiceResult, { ok: false; reason: "conflict" }>
  | Extract<TaskCancellationVerificationServiceResult, { ok: false; reason: "chain_error" }>;

/**
 * F-1705 "取消（需求方主动终止该节点，触发退款）": deliberately does NOT
 * reimplement chain verification/status-transition logic at the DAG layer
 * — it checks eligibility under a lock (repository.ts's
 * `withLockedActiveDagNode`, which releases that lock before returning)
 * and then calls `tasks/service.ts`'s `verifyCancellation` UNCHANGED, the
 * exact same function/endpoint a plain non-DAG task's cancellation goes
 * through. This mirrors T-1702's `activateDag`, which proved (via a real
 * Hardhat e2e test) that a DAG node's task integrates with Feature 6's
 * funding flow with ZERO DAG-specific server code — here, cancellation
 * integrates with the newly-built Feature 6 gap-fill (T-1705's own
 * `cancel-verifications` endpoint) the same way.
 *
 * Does NOT synchronously write `node_status = 'FAILED'` here — that would
 * duplicate `advanceDagNodes`' own terminal-sync phase (repository.ts),
 * which already treats a `CANCELLED` task exactly like a `REFUNDED` one
 * and converges the node to `FAILED` on its own next tick (`dag-poller.ts`
 * polls every few seconds — see that file's own interval). Node-status
 * sync has exactly one owner (`advanceDagNodes`'s terminal-sync UPDATE);
 * this function is not a second one. "该节点独立退款" (F-1705's own
 * wording) — the refund itself is the real, already-executed on-chain
 * `cancelTask` call this function verifies; "DAG 其余节点不受影响" holds
 * because only THIS node's own `task_id` is ever touched, by construction
 * (`verifyCancellation` only ever transitions the one `taskId` it's given).
 *
 * See repository.ts's `withLockedActiveDagNode` doc comment for the full
 * history: an earlier version held the eligibility lock across the whole
 * `verifyCancellation` call (T-1706 round-1 fix for a race with
 * `manualTakeoverDagNode`), which itself introduced a real connection-pool
 * deadlock risk (T-1707 round-2 finding) — that lock is now released
 * before `verifyCancellation` runs, at the cost of narrowing (not
 * eliminating) the original race back to an already-accepted scope gap.
 */
export async function cancelDagNode(
  pool: Pool,
  rpc: ChainRpcClient,
  sessionAddress: string,
  dagId: string,
  nodeId: string,
  txHash: string,
): Promise<CancelDagNodeResult> {
  const normalizedSessionAddress = normalizeAddress(sessionAddress);

  const locked = await withLockedActiveDagNode(
    pool,
    dagId,
    nodeId,
    normalizedSessionAddress,
    (taskId) => verifyCancellation(pool, rpc, sessionAddress, taskId, txHash),
  );

  switch (locked.outcome) {
    case "dag_not_found":
      return { ok: false, reason: "DAG_NOT_FOUND" };
    case "forbidden":
      return { ok: false, reason: "FORBIDDEN" };
    case "node_not_found":
      return { ok: false, reason: "NODE_NOT_FOUND" };
    case "node_not_active":
      return { ok: false, reason: "NODE_NOT_ACTIVE" };
    case "ran": {
      const result = locked.result;
      if (!result.ok && result.reason === "forbidden") {
        // Already checked at the DAG layer above (the locked node's own
        // task is always created with `requesterAddress: dagRow.
        // requester_address`, see repository.ts's
        // `createTasksForReadyNodes`), so this branch is unreachable in
        // practice — kept exhaustive rather than asserted away, matching
        // this codebase's "no non-null assertions" lint rule.
        return { ok: false, reason: "FORBIDDEN" };
      }
      return result;
    }
  }
}

export type SelectDagNodeResultServiceResult =
  | { ok: true; selectedNodeIds: string[] }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "FORBIDDEN" }
  | { ok: false; reason: "NOT_AGGREGATE"; detail: string }
  | { ok: false; reason: "INVALID_SELECTION"; detail: string };

/**
 * F-1706: thin wrapper around repository.ts's `selectDagNodeResult` — no
 * token resolution, no embedding trigger (this writes no `tasks` row at
 * all, see that function's own doc comment), so purely outcome-shape
 * translation, matching this module's established pattern.
 */
export async function selectDagNodeResult(
  pool: Pool,
  requesterAddress: string,
  dagId: string,
  nodeId: string,
  selectedNodeIds: string[],
): Promise<SelectDagNodeResultServiceResult> {
  const outcome = await selectDagNodeResultAtomic(
    pool,
    dagId,
    nodeId,
    requesterAddress,
    selectedNodeIds,
  );

  switch (outcome.outcome) {
    case "not_found":
      return { ok: false, reason: "NOT_FOUND" };
    case "forbidden":
      return { ok: false, reason: "FORBIDDEN" };
    case "not_aggregate":
      return {
        ok: false,
        reason: "NOT_AGGREGATE",
        detail: `节点类型为 ${outcome.nodeRole}，只有 AGGREGATE 类型的节点可以选择结果`,
      };
    case "invalid_selection":
      return {
        ok: false,
        reason: "INVALID_SELECTION",
        detail: `以下节点不是该汇总节点的已完成（DONE）直接前置节点，无法被选择：${outcome.invalidNodeIds.join(", ")}`,
      };
    case "selected":
      return { ok: true, selectedNodeIds: outcome.selectedNodeIds };
  }
}

/**
 * F-1707/F-1708's own budget bucketing, computed here (not in
 * repository.ts) so it stays a pure function over already-fetched rows —
 * trivially unit-testable without a database, matching this codebase's own
 * "keep pure decision logic separate from the DB round-trip that feeds it"
 * convention (see topology.ts's own doc comment for the same reasoning).
 *
 * The four buckets partition every node's EFFECTIVE budget by exactly one
 * mutually-exclusive category, derived from decision 1 (design.md): each
 * node's real fund state is its own linked `tasks.status`, nothing else.
 * `totalBudget === releasedBudget + refundedBudget + activeLockedBudget +
 * notYetFundedBudget` is therefore a true arithmetic identity BY
 * CONSTRUCTION (every node contributes to exactly one bucket) — this IS
 * AC-1705's "资金守恒" property for the projection itself; the real-chain
 * half of that assertion (the projection's numbers matching what actually
 * moved on-chain) is proven by `dag-detail.hardhat.e2e.test.ts`, not by
 * this function (a pure function has no chain to check against).
 *
 * N4 real finding (P1, T-1707 review): "effective budget" is
 * `node.taskBudget ?? node.subBudget`, NOT always `node.subBudget`. Once a
 * node has a real `taskId`, `PATCH /tasks/:taskId/draft` (Feature 6,
 * unmodified — nothing marks a DAG-activated task as budget-immutable)
 * lets the requester edit that task's OWN `budget` before funding it, and
 * the requester then funds/settles the EDITED amount on-chain, not the
 * node's original declared `subBudget`. Bucketing by `subBudget`
 * unconditionally would silently report a stale number the moment such an
 * edit happens — the conservation identity above would still hold
 * arithmetically, but against the WRONG total, defeating AC-1705's actual
 * point (matching REAL on-chain totals). `taskBudget` (repository.ts's own
 * doc comment on that field has the full reasoning) is only ever null when
 * `taskId` is null, so the fallback to `subBudget` exactly covers "nothing
 * to read from yet."
 */
export interface DagBudgetSummary {
  totalBudget: string;
  releasedBudget: string;
  refundedBudget: string;
  activeLockedBudget: string;
  notYetFundedBudget: string;
}

const RELEASED_TASK_STATUSES: ReadonlySet<string> = new Set(["RELEASED"]);
const REFUNDED_TASK_STATUSES: ReadonlySet<string> = new Set(["REFUNDED", "CANCELLED"]);
const ACTIVE_LOCKED_TASK_STATUSES: ReadonlySet<string> = new Set([
  "OPEN",
  "ACCEPTED",
  "SUBMITTED",
  "DISPUTED",
]);

export function aggregateDagBudget(
  nodes: Pick<DagDetailRow["nodes"][number], "subBudget" | "taskStatus" | "taskBudget">[],
): DagBudgetSummary {
  let total = 0n;
  let released = 0n;
  let refunded = 0n;
  let activeLocked = 0n;
  let notYetFunded = 0n;

  for (const node of nodes) {
    const effectiveBudget = BigInt(node.taskBudget ?? node.subBudget);
    total += effectiveBudget;
    if (node.taskStatus !== null && RELEASED_TASK_STATUSES.has(node.taskStatus)) {
      released += effectiveBudget;
    } else if (node.taskStatus !== null && REFUNDED_TASK_STATUSES.has(node.taskStatus)) {
      refunded += effectiveBudget;
    } else if (node.taskStatus !== null && ACTIVE_LOCKED_TASK_STATUSES.has(node.taskStatus)) {
      activeLocked += effectiveBudget;
    } else {
      // taskStatus === null (not yet activated) or DRAFT/AWAITING_FUNDING
      // (activated but the requester hasn't completed the real on-chain
      // approve+createTask yet, per decision 1's "延迟锁定" model) — in
      // both cases nothing has actually been locked in escrow yet.
      notYetFunded += effectiveBudget;
    }
  }

  return {
    totalBudget: total.toString(),
    releasedBudget: released.toString(),
    refundedBudget: refunded.toString(),
    activeLockedBudget: activeLocked.toString(),
    notYetFundedBudget: notYetFunded.toString(),
  };
}

export type GetDagDetailResult =
  | { ok: true; dag: DagDetailRow; budget: DagBudgetSummary }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "FORBIDDEN" };

/**
 * F-1707/design.md 接口契约: `GET /dags/:dagId`（需求方/管理员）— read-only,
 * no locking (a plain read, not a state transition — see repository.ts's
 * `getDagDetail` doc comment). Authorization is an explicit OR (requester
 * OR admin), checked here rather than via a single `preHandler` decorator,
 * since `app.requireAdmin` (admin/middleware.ts) is deliberately
 * self-sufficient/exclusive (its own doc comment: a route using it is
 * ADMIN-ONLY) — this endpoint needs the union of two different
 * authorization rules, not either one alone.
 */
export async function getDagDetail(
  pool: Pool,
  sessionAddress: string,
  dagId: string,
): Promise<GetDagDetailResult> {
  const dag = await getDagDetailAtomic(pool, dagId);
  if (!dag) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const normalizedSessionAddress = normalizeAddress(sessionAddress);
  if (dag.requesterAddress !== normalizedSessionAddress) {
    const isAdmin = await isAdminAddress(pool, normalizedSessionAddress);
    if (!isAdmin) {
      return { ok: false, reason: "FORBIDDEN" };
    }
  }

  return { ok: true, dag, budget: aggregateDagBudget(dag.nodes) };
}
