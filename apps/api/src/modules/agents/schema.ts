import { z } from "zod";

// Same lowercase-0x-hex40 shape nonce.store.ts's normalizeAddress enforces
// for wallet addresses, applied here to payoutAddress (F-507: address format
// safety check). Case is accepted either way at the API boundary and
// normalized in service.ts, matching how /auth accepts addresses.
const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");

const SKILL_TAG_SCHEMA = z.string().trim().min(1).max(50);

/**
 * F-501/F-507: everything POST /agents accepts. `ownerAddress` is
 * deliberately NOT a field here — it comes from the authenticated session
 * (`request.address` via `app.requireSession`), never from client input, so
 * a caller can't create an Agent owned by someone else's address.
 */
export const createAgentSchema = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(200),
  description: z.string().trim().min(1, "介绍不能为空").max(5000),
  category: z.string().trim().min(1, "分类不能为空").max(100),
  skillTags: z.array(SKILL_TAG_SCHEMA).max(20).default([]),
  authorBio: z.string().trim().max(2000).optional(),
  // Restricted to http(s) (Codex review, T-502 round 1, P2): this is a
  // plain display field (design.md — "仅作为展示字段"), but an unrestricted
  // URL scheme (e.g. `javascript:`) stored here would become a stored-XSS
  // vector the moment T-505's frontend renders it as a clickable link.
  invocationUrl: z
    .string()
    .trim()
    .url("调用地址必须是合法 URL")
    .max(2000)
    .refine((value) => /^https?:\/\//i.test(value), "调用地址必须是 http(s) URL")
    .optional(),
  payoutAddress: ETH_ADDRESS_SCHEMA,
  pricingModel: z.string().trim().max(100).optional(),
  referencePrice: z.number().finite().nonnegative().optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;

/**
 * F-502: `GET /agents` query params. `page`/`pageSize` arrive as strings
 * (query strings have no native number type) — `z.coerce.number()` parses
 * them, and `int().min(1)` rejects `0`, negative, or non-integer values
 * rather than silently clamping them into something plausible-looking.
 * `pageSize` is capped at 20 ("分页默认每页不超过 20 条", F-502) — this is a hard
 * ceiling, not just the default, so a client can't request an unbounded
 * page and defeat the point of pagination.
 */
export const listAgentsQuerySchema = z.object({
  category: z.string().trim().min(1).max(100).optional(),
  skillTag: z.string().trim().min(1).max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20),
});

export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

export const agentIdParamSchema = z.object({
  agentId: z.string().uuid("agentId 必须是合法的 UUID"),
});
