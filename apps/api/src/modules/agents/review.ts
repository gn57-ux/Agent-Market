import type { Pool } from "pg";
import { normalizeAddress } from "../auth/nonce.store.js";
import {
  listAgents,
  setAgentReviewStatus,
  type AgentRow,
  type ListAgentsResult,
} from "./repository.js";
import { requireOwnedAgent } from "./service.js";

/**
 * F-1605/F-1606/design.md's Agent 状态机 (决策 3): the review-lifecycle
 * business rules — which `review_status` a caller may transition an Agent
 * FROM and TO, and who's allowed to trigger it — live here, the one place
 * that owns them (CLAUDE.md 原则 6). `submitAgentForReview` needs an
 * ownership check (owner-only); `approveAgent`/`rejectAgent`/`suspendAgent`
 * don't (any admin may act on any Agent — `app.requireAdmin` already
 * enforced that before this module is ever called, so no address
 * comparison belongs here).
 */
export type AgentReviewActionResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; reason: "not_found" | "forbidden" | "invalid_transition" };

export type AdminAgentReviewActionResult =
  { ok: true; agent: AgentRow } | { ok: false; reason: "not_found" | "invalid_transition" };

/**
 * F-1605 (T-1605): `DRAFT → PENDING_REVIEW`, triggered by the Agent's own
 * owner. Design.md's state machine lists this as the entry point into
 * review for an Agent that wasn't auto-activated at creation (F-1604's
 * FREE-pricing fast path never reaches DRAFT at all — see service.ts's
 * `createAgent`, which sets `ACTIVE`/`PENDING_REVIEW` directly and never
 * `DRAFT`). No creation path in this codebase currently produces a
 * `DRAFT` Agent yet; this endpoint still exists per design.md's contract
 * (a future draft-save flow is out of THIS Task's scope to build) — any
 * other starting `review_status` is rejected as `invalid_transition`,
 * exactly like every other illegal state-machine edge this Feature
 * enforces.
 */
export async function submitAgentForReview(
  pool: Pool,
  sessionAddress: string,
  agentId: string,
): Promise<AgentReviewActionResult> {
  const owned = await requireOwnedAgent(pool, sessionAddress, agentId);
  if (!owned.ok) {
    return owned;
  }

  const actorAddress = normalizeAddress(sessionAddress);
  return setAgentReviewStatus(pool, agentId, (current) => {
    if (current.reviewStatus !== "DRAFT") {
      return null;
    }
    return { toReviewStatus: "PENDING_REVIEW", actorAddress, reason: "所有者提交审核。" };
  });
}

/**
 * F-1606 (T-1606): `REJECTED|SUSPENDED → PENDING_REVIEW`, triggered by the
 * Agent's own owner (design.md's state machine — "REJECTED/SUSPENDED →
 * PENDING_REVIEW（申诉触发重新审核）"). Owner-only, same as
 * `submitAgentForReview` above (reuses the same `requireOwnedAgent` check —
 * not duplicated). No `reason` parameter: tasks.md's T-1606 entry requires
 * only that the appeal itself be recorded ("记录申诉历史"), which the
 * standard `agent_review_audit_logs` row already captures (who, from which
 * state, when) — unlike `reject`/`suspend`, nothing in the spec asks the
 * OWNER to justify their own appeal in writing.
 */
export async function appealAgentReview(
  pool: Pool,
  sessionAddress: string,
  agentId: string,
): Promise<AgentReviewActionResult> {
  const owned = await requireOwnedAgent(pool, sessionAddress, agentId);
  if (!owned.ok) {
    return owned;
  }

  const actorAddress = normalizeAddress(sessionAddress);
  return setAgentReviewStatus(pool, agentId, (current) => {
    if (current.reviewStatus !== "REJECTED" && current.reviewStatus !== "SUSPENDED") {
      return null;
    }
    return { toReviewStatus: "PENDING_REVIEW", actorAddress, reason: "所有者申诉，请求重新审核。" };
  });
}

/** F-1605 (T-1605): `PENDING_REVIEW → ACTIVE`, admin-only. */
export async function approveAgent(
  pool: Pool,
  adminAddress: string,
  agentId: string,
): Promise<AdminAgentReviewActionResult> {
  const actorAddress = normalizeAddress(adminAddress);
  return setAgentReviewStatus(pool, agentId, (current) => {
    if (current.reviewStatus !== "PENDING_REVIEW") {
      return null;
    }
    return { toReviewStatus: "ACTIVE", actorAddress, reason: "管理员审核通过。" };
  });
}

/** F-1605 (T-1605): `PENDING_REVIEW → REJECTED`, admin-only, `reason`
 * required (schema.ts's `rejectAgentReviewSchema` enforces non-empty at
 * the request boundary; this layer trusts that and just records it). */
export async function rejectAgent(
  pool: Pool,
  adminAddress: string,
  agentId: string,
  reason: string,
): Promise<AdminAgentReviewActionResult> {
  const actorAddress = normalizeAddress(adminAddress);
  return setAgentReviewStatus(pool, agentId, (current) => {
    if (current.reviewStatus !== "PENDING_REVIEW") {
      return null;
    }
    return { toReviewStatus: "REJECTED", actorAddress, reason };
  });
}

/** F-1605/F-1606 (T-1605, v1.3 addition): `ACTIVE → SUSPENDED`, admin-only,
 * `reason` required — design.md's state machine only defines this
 * transition FROM `ACTIVE` (a `PENDING_REVIEW`/`DRAFT`/`REJECTED` Agent
 * was never live in the market to begin with; suspending it has no
 * meaning distinct from rejecting it). */
export async function suspendAgent(
  pool: Pool,
  adminAddress: string,
  agentId: string,
  reason: string,
): Promise<AdminAgentReviewActionResult> {
  const actorAddress = normalizeAddress(adminAddress);
  return setAgentReviewStatus(pool, agentId, (current) => {
    if (current.reviewStatus !== "ACTIVE") {
      return null;
    }
    return { toReviewStatus: "SUSPENDED", actorAddress, reason };
  });
}

/** F-1605 (T-1605): `GET /admin/agents/review-queue` — reuses `listAgents`'s
 * existing `reviewStatus` filter (repository.ts's own doc comment on
 * `ListAgentsFilter.reviewStatus` names this exact use case), hardcoded to
 * `PENDING_REVIEW` — never a caller-chosen filter, this endpoint has
 * exactly one meaning. */
export async function listReviewQueue(
  pool: Pool,
  page: number,
  pageSize: number,
): Promise<ListAgentsResult> {
  return listAgents(pool, { reviewStatus: "PENDING_REVIEW", page, pageSize });
}
