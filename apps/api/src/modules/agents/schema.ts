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

// F-1604/F-1605 (Feature 16, T-1604, design.md 决策 5) — the explicit
// pricing-mode enum that ALONE decides whether an Agent needs review
// (`pricingType === 'FREE'`), never inferred from `referencePrice` being
// empty/zero. Mirrors 0019_add_agent_review_status.sql's CHECK constraint
// exactly, same "one Zod rule per DB constraint" convention as
// PROTOCOL_VERSION_SCHEMA above.
const PRICING_TYPE_SCHEMA = z.enum(["FREE", "PER_TASK", "SUBSCRIPTION", "HOURLY"], {
  message: "pricingType 必须是 FREE/PER_TASK/SUBSCRIPTION/HOURLY 之一",
});

// F-1201/F-1202 (Feature 12): the migration's own CHECK constraints are the
// authoritative source of "what's legal" (0013_add_agent_task_credentials.sql)
// — these two schemas mirror those exact constraints so a malformed request
// gets a readable Chinese 400 instead of a raw Postgres constraint-violation
// error, matching this module's existing NAME_SCHEMA/CATEGORY_SCHEMA etc.
// pattern of "one Zod rule per DB constraint, defined once, reused by both
// create/update schemas."
//
// protocolVersion only has one legal value in this stage (the migration's
// own `CHECK (protocol_version = 'v1')`) — a `z.literal` rejects anything
// else with a clear message rather than a permissive `z.string()` that
// would just defer the same rejection to the database layer.
const PROTOCOL_VERSION_SCHEMA = z.literal("v1", { message: "协议版本目前只支持 v1" });
// credentialEnabled is a TOGGLE, not the reference string itself (T-1300).
// The owner never chooses or sees a raw `credentialRef` as API input —
// `true` asks the server to compute+set the one deterministic reference
// this Agent's own id produces (credential.ts's `computeCredentialRef`),
// `false` clears it back to unconfigured. This replaced an earlier
// free-text `credentialRef` field after a real Codex finding (T-1300 round
// 1, P1): a self-chosen reference string let an attacker who knows a
// victim Agent's public id pre-claim `env://AGENT_<victim's id>` before the
// operator ever provisioned it — see 0013_add_agent_task_credentials.sql's
// migration comment for the full writeup. The actual resolved value
// (`agent.credentialRef` in every read response) is still a real, never-
// echoed-secret reference string — only the WRITE side changed.
const CREDENTIAL_ENABLED_SCHEMA = z.boolean();

// `reference_price` is a PostgreSQL NUMERIC column (arbitrary precision) and
// `node-postgres` already reads it back out as a string rather than a JS
// `number` (routes.ts's toAgentSummaryJson doc comment). Accepting it as a
// JS `number` on the way IN would break that symmetry: a JSON body's number
// literal is parsed into an IEEE-754 double before Zod (or this code) ever
// sees it — precision beyond ~15-17 significant digits is already lost by
// the time `JSON.parse` returns, independent of anything this schema does.
// The only way to preserve a caller's exact decimal text end-to-end is to
// never convert it to a `number` at all.
//
// Two approaches were compared (Codex review, T-505 round 3, blocking):
//
// Option A (chosen): accept a plain decimal string, validated with a regex,
// stored as-is (the SQL driver binds a JS string to a NUMERIC column
// without any precision-lossy conversion; Postgres itself parses the text
// as an arbitrary-precision NUMERIC literal). Zero new dependencies — this
// project already established "NUMERIC stays a string at the API boundary"
// for reads; this makes writes symmetric with that, rather than adding a
// second, format-lossy convention for the same column.
//
// Option B (not chosen): adopt an arbitrary-precision decimal library
// (e.g. decimal.js/big.js) on both apps/api and apps/web to parse/validate/
// format the value through a `Decimal` type. Gives real decimal arithmetic
// (add/compare/round), which this feature never needs — nothing here does
// math on `referencePrice`, it only stores and echoes it back. Adds a
// dependency to two packages, plus a wrapper type at every read/write site,
// to solve a "validate this looks like a plain decimal" problem a ~40-
// character regex already solves. Matches this project's stated stance
// against pulling in a library for functionality implementable in a few
// lines (see signInMessage.ts's decision record for the same reasoning
// applied to SIWE).
//
// Format: an unsigned decimal — at least one leading digit, an optional
// fractional part with at least one digit after the point. No sign (this
// field is nonnegative by definition), no scientific notation (a NUMERIC
// literal doesn't use it, and accepting "1e10" here would silently diverge
// from what actually gets stored). `max(80)` is a sane abuse guard, not a
// precision ceiling — Postgres NUMERIC itself supports far more digits than
// any real price needs; 80 was chosen because it comfortably exceeds
// uint256's 78-decimal-digit maximum (this is a Web3 project; that's the
// largest "real" magnitude anything here would plausibly need to express).
const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;
const REFERENCE_PRICE_SCHEMA = z
  .string()
  .trim()
  .max(80, "参考价格过长")
  .regex(DECIMAL_STRING_PATTERN, "参考价格必须是非负十进制数字（不支持科学计数法或负数）");

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
  // F-1604 (T-1604): REQUIRED, not optional — every new Agent going
  // forward must explicitly declare its pricing mode (design.md 决策 5's
  // whole point: no inference from referencePrice, no silent default for
  // NEW creations). The migration's own 'PER_TASK' DEFAULT exists only to
  // backfill HISTORICAL rows that predate this column; a fresh POST
  // /agents omitting this field is a client bug, not a legitimate "use
  // the default" case.
  pricingType: PRICING_TYPE_SCHEMA,
  // Omitted entirely uses the migration's own DEFAULT ('v1'); the only
  // reason a caller would supply it explicitly is to be self-documenting.
  protocolVersion: PROTOCOL_VERSION_SCHEMA.optional(),
  // Omitted or `false` = no credential configured at creation (the common
  // case: nothing to enable yet). `true` computes and sets the canonical
  // reference immediately (repository.ts does the insert, then a
  // same-transaction update once the row's real id exists).
  credentialEnabled: CREDENTIAL_ENABLED_SCHEMA.optional(),
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

/** F-1204's diagnostic endpoint request body (T-1203): an arbitrary JSON
 * payload the caller wants forwarded to the Agent's invocationUrl — this
 * module has no opinion on its shape, invocation-client.ts passes it
 * through verbatim. */
export const invocationTestSchema = z.object({
  payload: z.unknown(),
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
  // Not nullable (unlike authorBio/pricingModel/referencePrice above):
  // protocol_version is `NOT NULL DEFAULT 'v1'` with no "unset" state to
  // clear back to — there's only ever the one legal value.
  protocolVersion: PROTOCOL_VERSION_SCHEMA.optional(),
  // `undefined` = don't change; `true` = enable (compute+set the canonical
  // reference for this Agent's own id); `false` = disable (clear back to
  // unconfigured) — a plain boolean already covers all three states a
  // toggle needs, no `null` variant required.
  credentialEnabled: CREDENTIAL_ENABLED_SCHEMA.optional(),
});

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

/**
 * F-1604 (T-1604, design.md 决策 5) — `POST /agents/:agentId/pricing-type`'s
 * body. Deliberately NOT a field on `updateAgentSchema`/the general PATCH:
 * design.md 决策 5 explicitly requires that a pricingType change "须走显式
 * 确认，不能是普通字段 PATCH 静默生效" — a plain PATCH could silently flip an
 * Agent between FREE (no review) and a paid mode as a side effect of an
 * unrelated edit (e.g. updating `description` in the same request body).
 * This mirrors the codebase's own established precedent for state-
 * changing actions with real side effects: dedicated `POST .../activate`
 * `.../deactivate` action routes, not a general-purpose PATCH field
 * (confirmed against this module's existing routes.ts — no
 * "confirmation flag" pattern exists anywhere else in this codebase to
 * follow instead).
 */
export const changeAgentPricingTypeSchema = z.object({
  pricingType: PRICING_TYPE_SCHEMA,
});

export type ChangeAgentPricingTypeInput = z.infer<typeof changeAgentPricingTypeSchema>;

// F-1605/T-1605: design.md's interface contract requires reject to carry a
// reason ("reject 必须携带 reason"), and tasks.md's T-1605 entry explicitly
// extends the SAME requirement to suspend ("与 reject 共享'拒绝/停用理由必
// 填'的应用层校验") — one rule, defined once, reused by both schemas below
// rather than two independently-drifting copies (CLAUDE.md 原则 6: 设计知识
// 只能有一个归属).
const REVIEW_REASON_SCHEMA = z.string().trim().min(1, "必须填写理由");

export const rejectAgentReviewSchema = z.object({
  reason: REVIEW_REASON_SCHEMA,
});

export const suspendAgentReviewSchema = z.object({
  reason: REVIEW_REASON_SCHEMA,
});

export type RejectAgentReviewInput = z.infer<typeof rejectAgentReviewSchema>;
export type SuspendAgentReviewInput = z.infer<typeof suspendAgentReviewSchema>;

// GET /admin/agents/review-queue's own pagination — same page/pageSize
// rules as listAgentsQuerySchema above, but no category/skillTag/status
// (the queue is always exactly reviewStatus='PENDING_REVIEW', not a
// caller-chosen filter), so this is its own small schema rather than an
// awkward `.pick()`/`.omit()` off a schema whose other fields don't apply
// here.
export const reviewQueueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20),
});

export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;
