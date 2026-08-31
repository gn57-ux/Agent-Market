import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import {
  getAgentById,
  insertAgent,
  listAgents,
  setAgentStatus,
  updateAgent as updateAgentRow,
  type AgentRow,
  type AgentStatus,
  type ListAgentsResult,
} from "./repository.js";
import type { CreateAgentInput, ListAgentsQuery, UpdateAgentInput } from "./schema.js";
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
type OwnershipCheckResult =
  { ok: true; agent: AgentRow } | { ok: false; reason: "not_found" | "forbidden" };

async function requireOwnedAgent(
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

/** F-502: thin pass-through to the repository — pagination/filter parsing
 * already happened in schema.ts, there's no ownership or default-value
 * logic to apply for a read-only listing. */
export async function listAgentsForMarket(
  pool: Queryable,
  query: ListAgentsQuery,
): Promise<ListAgentsResult> {
  return listAgents(pool, {
    category: query.category,
    skillTag: query.skillTag,
    status: query.status,
    page: query.page,
    pageSize: query.pageSize,
  });
}

/** F-502/F-508: `null` when no Agent exists with this id — routes.ts turns
 * that into a 404, this layer just reports absence. */
export async function getAgentDetail(pool: Queryable, agentId: string): Promise<AgentRow | null> {
  return getAgentById(pool, agentId);
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
