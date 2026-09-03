import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import {
  getAgentById,
  insertAgent,
  listAgents,
  setAgentPricingType,
  setAgentStatus,
  updateAgent as updateAgentRow,
  type AgentRow,
  type AgentStatus,
  type ListAgentsResult,
} from "./repository.js";
import type {
  ChangeAgentPricingTypeInput,
  CreateAgentInput,
  ListAgentsQuery,
  UpdateAgentInput,
} from "./schema.js";
import { callAgent, type InvocationResult } from "./invocation-client.js";

/**
 * Shared ownership-check result shape for F-503/F-504's mutating
 * operations: `not_found` (no such Agent — 404) and `forbidden` (Agent
 * exists but `sessionAddress` isn't its owner — 403) need different HTTP
 * statuses, so routes.ts must be able to tell them apart rather than this
 * layer collapsing both into a single boolean.
 */
export type AgentMutationResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; reason: "not_found" | "forbidden" | "credential_ref_conflict" };

/** `pg` reports a unique-constraint violation as SQLSTATE `23505`. The
 * `agents` table's only unique constraint on `credential_ref` is
 * `agents_credential_ref_unique_idx` (0013_add_agent_task_credentials.sql,
 * T-1203 round-2 Finding 1 fix), so any `23505` surfacing from
 * `insertAgent`/`updateAgentRow` is that constraint — mirrors
 * tasks/service.ts's own `isUniqueViolation` helper of the same name and
 * purpose (that table's own single non-PK unique constraint). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/** Narrower than `AgentMutationResult` — ownership checks alone can never
 * produce `credential_ref_conflict` (that reason only comes from a later
 * insert/update attempt), so this stays its own type rather than widening
 * every `requireOwnedAgent` call site (including `testAgentInvocation`'s,
 * which never touches credential_ref writes at all) to handle a reason it
 * can't actually receive. */
export type OwnershipCheckResult =
  { ok: true; agent: AgentRow } | { ok: false; reason: "not_found" | "forbidden" };

/** Exported so review.ts's `submitAgentForReview` (T-1605) can reuse the
 * exact same ownership check rather than re-deriving it — the rule
 * "session address must match the Agent's owner_address, case-
 * insensitively" belongs here once (CLAUDE.md 原则 6). */
export async function requireOwnedAgent(
  pool: Queryable,
  sessionAddress: string,
  agentId: string,
): Promise<OwnershipCheckResult> {
  const agent = await getAgentById(pool, agentId);
  if (!agent) {
    return { ok: false, reason: "not_found" };
  }
  if (agent.ownerAddress !== normalizeAddress(sessionAddress)) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, agent };
}

/**
 * F-501/F-506: creates an Agent owned by `sessionAddress` (the caller's
 * verified session address — routes.ts gets this from `request.address`,
 * never from request body input, so ownership can't be spoofed). Normalizes
 * both the owner and payout addresses the same way `/auth` does (nonce.store
 * ts's `normalizeAddress` is the one place that owns this rule) since the
 * `agents` table's CHECK constraints require lowercase hex — an
 * EIP-55-checksummed (mixed-case) `payoutAddress` from the client would
 * otherwise fail the INSERT with a raw constraint-violation error instead
 * of being accepted like any other valid address.
 *
 * Deduplicates `skillTags` (case-sensitive) before inserting: `agent_skills`
 * has a `(agent_id, skill_tag)` primary key, so a client submitting the same
 * tag twice would otherwise fail the insert on a uniqueness violation that
 * has nothing to do with genuinely invalid input.
 *
 * Returns `credential_ref_conflict` (routes.ts maps this to 409) instead of
 * throwing when `input.credentialRef` is already claimed by a different
 * Agent — the database's own partial unique index is what actually
 * enforces this (T-1203 round-2 Finding 1 fix), this just translates that
 * raw constraint violation into a typed result the same way `not_found`/
 * `forbidden` are translated elsewhere in this module, instead of letting a
 * raw `pg` error reach routes.ts as an unhandled 500.
 */
export type CreateAgentResult =
  { ok: true; agent: AgentRow } | { ok: false; reason: "credential_ref_conflict" };

export async function createAgent(
  pool: Pool,
  sessionAddress: string,
  input: CreateAgentInput,
): Promise<CreateAgentResult> {
  const ownerAddress = normalizeAddress(sessionAddress);
  const payoutAddress = normalizeAddress(input.payoutAddress);
  const skillTags = [...new Set(input.skillTags)];
  // F-1604 (design.md 决策 5, T-1604) — the ENTIRE review-routing rule,
  // owned exactly here and nowhere else: FREE Agents skip review
  // (F-1604's direct-to-market path), every other pricing mode enters
  // PENDING_REVIEW (F-1605). `pricingType` alone decides this — never
  // `referencePrice`'s presence/value (the exact inference design.md
  // 决策 5 rejected as a real, demonstrated review-bypass vulnerability).
  const reviewStatus = input.pricingType === "FREE" ? "ACTIVE" : "PENDING_REVIEW";

  try {
    const agent = await insertAgent(pool, {
      ownerAddress,
      name: input.name,
      description: input.description,
      category: input.category,
      authorBio: input.authorBio,
      invocationUrl: input.invocationUrl,
      payoutAddress,
      pricingModel: input.pricingModel,
      referencePrice: input.referencePrice,
      pricingType: input.pricingType,
      reviewStatus,
      skillTags,
      protocolVersion: input.protocolVersion,
      credentialEnabled: input.credentialEnabled,
    });
    return { ok: true, agent };
  } catch (error) {
    // T-1300: credential_ref is now a deterministic function of the row's
    // own id (0013's CHECK), so this specific violation is no longer
    // reachable in practice — kept as defensive translation rather than
    // letting any future regression surface as a raw, unhandled 500.
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "credential_ref_conflict" };
    }
    throw error;
  }
}

/**
 * F-502/AC-1604: pagination/filter parsing already happened in schema.ts,
 * but this is NOT a pure pass-through — `reviewStatus: "ACTIVE"` is
 * unconditionally forced here, never taken from `query` (there is no
 * `reviewStatus` field on `ListAgentsQuery`/`listAgentsQuerySchema` at
 * all — a caller cannot override this). AC-1604's actual requirement
 * ("付费 Agent 创建后不可见，直到审核通过") applies to every caller of the
 * PUBLIC market listing with no exception, including the Agent's own
 * owner — an owner who wants to check their own pending Agent's status
 * uses `GET /agents/:agentId` directly (unaffected by this filter), not
 * this listing. A future admin review-queue endpoint (T-1605) reuses
 * `listAgents` directly with its own explicit `reviewStatus`, not through
 * this market-specific wrapper.
 */
export async function listAgentsForMarket(
  pool: Queryable,
  query: ListAgentsQuery,
): Promise<ListAgentsResult> {
  return listAgents(pool, {
    category: query.category,
    skillTag: query.skillTag,
    status: query.status,
    reviewStatus: "ACTIVE",
    page: query.page,
    pageSize: query.pageSize,
  });
}

/**
 * F-502/F-508: `null` when no Agent exists with this id, OR (Codex review,
 * T-1605 round 1 P1) when it exists but the viewer isn't allowed to see it
 * yet — routes.ts turns either case into the SAME 404, deliberately: a
 * `PENDING_REVIEW`/`REJECTED`/`SUSPENDED` Agent must stay indistinguishable
 * from "doesn't exist" to anyone but its own owner or an admin (AC-1604's
 * "审核通过前不可见" only actually held for `GET /agents`'s list — this
 * endpoint had no `reviewStatus` check at all, so a stranger who knew or
 * guessed the UUID could still read the full detail of an Agent that was
 * never supposed to be visible to them). A 403 here would leak the Agent's
 * existence and current review state to someone with no right to either.
 */
export async function getAgentDetail(
  pool: Queryable,
  agentId: string,
  viewer: { address: string | undefined; isAdmin: boolean },
): Promise<AgentRow | null> {
  const agent = await getAgentById(pool, agentId);
  if (!agent) {
    return null;
  }
  const isOwner =
    viewer.address !== undefined && agent.ownerAddress === normalizeAddress(viewer.address);
  if (agent.reviewStatus !== "ACTIVE" && !isOwner && !viewer.isAdmin) {
    return null;
  }
  return agent;
}

/**
 * F-503: applies a partial edit, but only after confirming `sessionAddress`
 * owns the Agent (AC-505: "非归属地址操作被拒绝") — checked here rather than at
 * the SQL layer so `not_found` and `forbidden` stay distinguishable for
 * routes.ts. Normalizes `payoutAddress`/dedupes `skillTags` the same way
 * `createAgent` does, only for whichever of those two fields is actually
 * present in `input`.
 */
export async function updateAgent(
  pool: Pool,
  sessionAddress: string,
  agentId: string,
  input: UpdateAgentInput,
): Promise<AgentMutationResult> {
  const owned = await requireOwnedAgent(pool, sessionAddress, agentId);
  if (!owned.ok) {
    return owned;
  }

  let updated: AgentRow | null;
  try {
    updated = await updateAgentRow(pool, agentId, {
      name: input.name,
      description: input.description,
      category: input.category,
      authorBio: input.authorBio,
      invocationUrl: input.invocationUrl,
      payoutAddress: input.payoutAddress ? normalizeAddress(input.payoutAddress) : undefined,
      pricingModel: input.pricingModel,
      referencePrice: input.referencePrice,
      skillTags: input.skillTags ? [...new Set(input.skillTags)] : undefined,
      protocolVersion: input.protocolVersion,
      credentialEnabled: input.credentialEnabled,
    });
  } catch (error) {
    // Same translation as createAgent (no longer practically reachable —
    // see that function's own comment).
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "credential_ref_conflict" };
    }
    throw error;
  }
  if (!updated) {
    // Agent existed at the ownership check above but is gone now — a
    // concurrent delete would be the only way this branch is reachable
    // (no delete endpoint exists yet, so this is defensive, not expected).
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, agent: updated };
}

/**
 * F-504: activate/deactivate — same ownership check as `updateAgent`
 * (AC-505), just a direct status assignment rather than a general patch.
 */
export async function setAgentActiveStatus(
  pool: Pool,
  sessionAddress: string,
  agentId: string,
  status: AgentStatus,
): Promise<AgentMutationResult> {
  const owned = await requireOwnedAgent(pool, sessionAddress, agentId);
  if (!owned.ok) {
    return owned;
  }

  const updated = await setAgentStatus(pool, agentId, status);
  if (!updated) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, agent: updated };
}

/**
 * F-1604 (design.md 决策 5, T-1604) — the dedicated, explicit-confirmation
 * pricing-type change (never available via the general `updateAgent`
 * PATCH — see schema.ts's `changeAgentPricingTypeSchema` doc comment for
 * why). Same ownership check as `updateAgent`/`setAgentActiveStatus`.
 *
 * The re-review rule is specifically about crossing the FREE boundary —
 * design.md 决策 5's actual concern ("Agent 所有者不能靠改价格模式绕过审核"):
 * - non-FREE → FREE: no re-review needed, FREE never requires it —
 *   `review_status` moves directly to `ACTIVE` (matches F-1604's own
 *   direct-to-market rule for FREE Agents at creation time).
 * - FREE → non-FREE: MUST re-enter review — this is the exact bypass
 *   design.md 决策 5 closes: an owner cannot create as FREE (skip review),
 *   then flip to a paid mode and keep the free pass.
 * - non-FREE → a different non-FREE mode (e.g. PER_TASK → SUBSCRIPTION):
 *   no review-status change — this Agent was already reviewed as "some
 *   paid mode" and stays reviewed; design.md 决策 5 never asked for
 *   re-review on every pricing edit, only at the FREE boundary.
 * Every crossing writes an `agent_review_audit_logs` row (F-1607) via
 * `setAgentPricingType`'s single transaction; a non-crossing change does
 * not (there is no review-status transition to audit).
 *
 * N4 round-1 real findings (both P1), both fixed here:
 *
 * 1. REJECTED/SUSPENDED override — the platform (T-1605/T-1606, later
 *    Tasks) can reject or suspend an Agent, a deliberate adverse decision
 *    about that specific Agent. The FREE-boundary rule above, applied
 *    unconditionally, would let the OWNER silently reverse that decision
 *    just by toggling pricingType (switch to FREE → auto-ACTIVE overwrites
 *    a REJECTED/SUSPENDED verdict; switch away from FREE while already
 *    SUSPENDED → auto-PENDING_REVIEW does the same). Only admin approve or
 *    the owner's own appeal flow may move an Agent out of REJECTED/
 *    SUSPENDED — never a pricing-type change alone. Guarded below: when
 *    the CURRENT (freshly-locked) review_status is REJECTED or SUSPENDED,
 *    the decision callback returns `null` — pricing_type still updates
 *    (still a legitimate business-config edit), review_status does not.
 * 2. Race condition — `wasFree`/`willBeFree` are no longer computed from
 *    `owned.agent` (a pre-transaction snapshot read before any lock).
 *    That snapshot could be stale by the time `setAgentPricingType`
 *    actually acquires its row lock, letting two concurrent requests both
 *    decide from the same stale state (see that function's own doc
 *    comment for the exact exploitable sequence this produced). The
 *    decision is now a callback `setAgentPricingType` invokes AFTER its
 *    own `SELECT ... FOR UPDATE`, so `current` is guaranteed to be
 *    whatever the last COMMITTED write actually left behind.
 */
export async function changeAgentPricingType(
  pool: Pool,
  sessionAddress: string,
  agentId: string,
  input: ChangeAgentPricingTypeInput,
): Promise<AgentMutationResult> {
  const owned = await requireOwnedAgent(pool, sessionAddress, agentId);
  if (!owned.ok) {
    return owned;
  }

  const actorAddress = normalizeAddress(sessionAddress);
  const newPricingType = input.pricingType;

  const updated = await setAgentPricingType(pool, agentId, newPricingType, (current) => {
    if (current.reviewStatus === "REJECTED" || current.reviewStatus === "SUSPENDED") {
      return null;
    }
    const wasFree = current.pricingType === "FREE";
    const willBeFree = newPricingType === "FREE";
    if (wasFree === willBeFree) {
      return null;
    }
    return willBeFree
      ? {
          toReviewStatus: "ACTIVE",
          actorAddress,
          reason: "pricingType 变更为 FREE，无需审核直接上架。",
        }
      : {
          toReviewStatus: "PENDING_REVIEW",
          actorAddress,
          reason: `pricingType 从 FREE 变更为 ${newPricingType}，需重新进入审核。`,
        };
  });
  if (!updated) {
    // Same defensive "existed at the ownership check, gone now" case as
    // updateAgent — no delete endpoint exists, so not expected in practice.
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, agent: updated };
}

export type AgentInvocationTestResult =
  { ok: true; result: InvocationResult } | { ok: false; reason: "not_found" | "forbidden" };

/**
 * F-1204's diagnostic endpoint (`POST /agents/:agentId/invocation-test`,
 * T-1203) — same ownership check as `updateAgent`/`setAgentActiveStatus`
 * (only the Agent's own owner may trigger a call using its configured
 * credential), then a real `callAgent` call. Purely diagnostic: no task,
 * dispatch, or settlement state is read or written here (design.md's
 * "范围边界" — this never drives any business flow).
 */
export async function testAgentInvocation(
  pool: Queryable,
  sessionAddress: string,
  agentId: string,
  payload: unknown,
): Promise<AgentInvocationTestResult> {
  const owned = await requireOwnedAgent(pool, sessionAddress, agentId);
  if (!owned.ok) {
    return owned;
  }
  const result = await callAgent(
    { invocationUrl: owned.agent.invocationUrl, credentialRef: owned.agent.credentialRef },
    payload,
  );
  return { ok: true, result };
}
