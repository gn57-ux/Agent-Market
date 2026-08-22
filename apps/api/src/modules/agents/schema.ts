import { z } from "zod";

// Same lowercase-0x-hex40 shape nonce.store.ts's normalizeAddress enforces
// for wallet addresses, applied here to payoutAddress (F-507: address format
// safety check). Case is accepted either way at the API boundary and
// normalized in service.ts, matching how /auth accepts addresses.
const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");

const SKILL_TAG_SCHEMA = z.string().trim().min(1).max(50);

// Each field's validation rule is defined exactly once here and reused by
// both createAgentSchema and updateAgentSchema below (CLAUDE.md 原则: 设计知
// 识只能有一个归属) — the two schemas differ only in optional/nullable
// wrapping, never in the underlying rule (length limits, URL scheme
// restriction, etc.).
const NAME_SCHEMA = z.string().trim().min(1, "名称不能为空").max(200);
const DESCRIPTION_SCHEMA = z.string().trim().min(1, "介绍不能为空").max(5000);
const CATEGORY_SCHEMA = z.string().trim().min(1, "分类不能为空").max(100);
const AUTHOR_BIO_SCHEMA = z.string().trim().max(2000);
// Restricted to http(s) (Codex review, T-502 round 1, P2): this is a plain
// display field (design.md — "仅作为展示字段"), but an unrestricted URL scheme
// (e.g. `javascript:`) stored here would become a stored-XSS vector the
// moment T-505's frontend renders it as a clickable link.
const INVOCATION_URL_SCHEMA = z
  .string()
  .trim()
  .url("调用地址必须是合法 URL")
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), "调用地址必须是 http(s) URL");
const PRICING_MODEL_SCHEMA = z.string().trim().max(100);
const REFERENCE_PRICE_SCHEMA = z.number().finite().nonnegative();

/**
 * F-501/F-507: everything POST /agents accepts. `ownerAddress` is
 * deliberately NOT a field here — it comes from the authenticated session
 * (`request.address` via `app.requireSession`), never from client input, so
 * a caller can't create an Agent owned by someone else's address.
 */
export const createAgentSchema = z.object({
  name: NAME_SCHEMA,
  description: DESCRIPTION_SCHEMA,
  category: CATEGORY_SCHEMA,
  skillTags: z.array(SKILL_TAG_SCHEMA).max(20).default([]),
  authorBio: AUTHOR_BIO_SCHEMA.optional(),
  invocationUrl: INVOCATION_URL_SCHEMA.optional(),
  payoutAddress: ETH_ADDRESS_SCHEMA,
  pricingModel: PRICING_MODEL_SCHEMA.optional(),
  referencePrice: REFERENCE_PRICE_SCHEMA.optional(),
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
  // AC-505: "停用的 Agent 通过 GET /agents 可被状态筛选排除" — omitted entirely
  // (the default), the listing is unfiltered by status (matches T-503's
  // existing behavior); a caller passing status=ACTIVE excludes INACTIVE
  // Agents (Codex review, T-504 round 1, P1: this was missing entirely).
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20),
});

export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

export const agentIdParamSchema = z.object({
  agentId: z.string().uuid("agentId 必须是合法的 UUID"),
});

/**
 * F-503: `PATCH /agents/:agentId` body — `Partial<CreateAgentInput>`
 * (design.md's interface contract), with one addition: `authorBio`,
 * `invocationUrl`, `pricingModel`, and `referencePrice` also accept an
 * explicit `null` (Codex review, T-505 round 1, P2). A key genuinely
 * absent from the request body parses to `undefined` and is left
 * untouched by repository.ts's `updateAgent` ("don't change this field");
 * `null` clears it. Without this distinction there was no way for a
 * client to intentionally clear an optional field it had previously set —
 * every value the frontend's blank-field handling could send collapsed to
 * "don't change," so a cleared form field silently failed to clear
 * anything server-side. `name`/`description`/`category`/`payoutAddress`
 * stay non-nullable — they're required at creation and PRD has no "clear
 * an Agent's name" scenario. `ownerAddress` was never part of
 * `createAgentSchema` to begin with, so there's nothing here a client
 * could use to reassign ownership.
 */
export const updateAgentSchema = z.object({
  name: NAME_SCHEMA.optional(),
  description: DESCRIPTION_SCHEMA.optional(),
  category: CATEGORY_SCHEMA.optional(),
  skillTags: z.array(SKILL_TAG_SCHEMA).max(20).optional(),
  authorBio: AUTHOR_BIO_SCHEMA.nullable().optional(),
  invocationUrl: INVOCATION_URL_SCHEMA.nullable().optional(),
  payoutAddress: ETH_ADDRESS_SCHEMA.optional(),
  pricingModel: PRICING_MODEL_SCHEMA.nullable().optional(),
  referencePrice: REFERENCE_PRICE_SCHEMA.nullable().optional(),
});

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
