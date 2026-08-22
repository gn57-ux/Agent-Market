import type { Pool } from "pg";
import { normalizeAddress } from "../auth/nonce.store.js";
import { insertAgent, type AgentRow } from "./repository.js";
import type { CreateAgentInput } from "./schema.js";

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
