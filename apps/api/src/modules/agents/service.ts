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

/**
 * Shared ownership-check result shape for F-503/F-504's mutating
 * operations: `not_found` (no such Agent — 404) and `forbidden` (Agent
 * exists but `sessionAddress` isn't its owner — 403) need different HTTP
 * statuses, so routes.ts must be able to tell them apart rather than this
 * layer collapsing both into a single boolean.
 */
export type AgentMutationResult =
  { ok: true; agent: AgentRow } | { ok: false; reason: "not_found" | "forbidden" };

async function requireOwnedAgent(
  pool: Queryable,
  sessionAddress: string,
  agentId: string,
): Promise<AgentMutationResult> {
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
 */
export async function createAgent(
  pool: Pool,
  sessionAddress: string,
  input: CreateAgentInput,
): Promise<AgentRow> {
  const ownerAddress = normalizeAddress(sessionAddress);
  const payoutAddress = normalizeAddress(input.payoutAddress);
  const skillTags = [...new Set(input.skillTags)];

  return insertAgent(pool, {
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
  });
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

  const updated = await updateAgentRow(pool, agentId, {
    name: input.name,
    description: input.description,
    category: input.category,
    authorBio: input.authorBio,
    invocationUrl: input.invocationUrl,
    payoutAddress: input.payoutAddress ? normalizeAddress(input.payoutAddress) : undefined,
    pricingModel: input.pricingModel,
    referencePrice: input.referencePrice,
    skillTags: input.skillTags ? [...new Set(input.skillTags)] : undefined,
  });
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
