import { z } from "zod";

// Each field's validation rule is defined exactly once here and reused by
// both createDraftSchema and updateDraftSchema below (CLAUDE.md 原则: 设计知识
// 只能有一个归属), matching agents/schema.ts's structure — the two schemas
// differ only in optional wrapping, never in the underlying rule.
const CATEGORY_SCHEMA = z.string().trim().min(1, "分类不能为空").max(100);
const SKILL_TAG_SCHEMA = z.string().trim().min(1).max(50);
const TITLE_SCHEMA = z.string().trim().min(1, "标题不能为空").max(200);
const DESCRIPTION_SCHEMA = z.string().trim().min(1, "描述不能为空").max(5000);

// `tasks.budget` is a PostgreSQL NUMERIC column (0005_create_tasks.sql),
// bound as a plain string for the same precision reason as agents'
// `reference_price` (a JSON number literal is already lossy by the time Zod
// sees it) — but UNLIKE referencePrice, this value is not just a display
// figure: T-604 hands it straight to `TaskEscrow.createTask`'s `uint256
// budget` parameter (contracts/src/TaskEscrow.sol), and packages/domain's
// `Amount`/`parseAmount` (Feature 11) establishes this project's one
// convention for that boundary — amounts crossing into contract-call
// territory are minimal-unit unsigned integers (e.g. wei-equivalent), never
// a human decimal. F-609 states this explicitly ("金额统一使用最小单位无符号整数
// 存储与传输；前端仅负责格式化显示"). A decimal string like "125.5" has no
// valid `uint256` representation and would break T-604's transaction
// construction outright, so this schema rejects a decimal point entirely —
// the frontend (T-606) is responsible for converting a user's human-entered
// amount via `parseAmount()` before it ever reaches this endpoint.
const MINIMAL_UNIT_INTEGER_PATTERN = /^\d+$/;

// `uint256`'s maximum representable value (2^256 - 1, 78 decimal digits).
// The regex/length checks above only rule out non-digit characters and
// obviously-too-long strings (>80 chars) — they do not by themselves bound
// the value to what `TaskEscrow.createTask`'s `uint256 budget` parameter can
// actually encode. A 78-digit string that's numerically above this constant
// (or a 79/80-digit string) would still pass those checks, get persisted as
// a task draft, and then permanently fail at funding time because the
// frontend cannot construct a valid on-chain call for it — so this is
// checked here, at input validation, rather than discovered later as an
// unfundable draft.
const MAX_UINT256 = 2n ** 256n - 1n;

const BUDGET_SCHEMA = z
  .string()
  .trim()
  .max(80, "预算数值过长")
  .regex(
    MINIMAL_UNIT_INTEGER_PATTERN,
    "预算必须是最小单位的非负整数字符串（不支持小数、科学计数法或负数）",
  )
  .refine(
    (value) => {
      // Zod runs all chained checks on a ZodString even after an earlier
      // one (the regex above) has already failed — it does not short-
      // circuit — so `value` is not guaranteed to be all-digits by the time
      // this predicate runs. Guard with the same pattern rather than
      // letting a non-digit string reach `BigInt()` and throw: the regex
      // check above already reports that failure, this refinement only
      // needs to add a second issue for the in-range-but-too-large case.
      if (!MINIMAL_UNIT_INTEGER_PATTERN.test(value)) {
        return true;
      }
      return BigInt(value) <= MAX_UINT256;
    },
    { message: `预算数值超出 uint256 可表示的最大值（${MAX_UINT256.toString()}）` },
  )
  .refine(
    (value) => {
      // Same not-short-circuiting caveat as the refine above.
      if (!MINIMAL_UNIT_INTEGER_PATTERN.test(value)) {
        return true;
      }
      // `TaskEscrow.createTask` explicitly reverts with `ZeroBudget()` when
      // `budget == 0` (contracts/src/TaskEscrow.sol). A draft accepted with
      // budget "0" would pass every check here, transition to
      // AWAITING_FUNDING via funding-intent, and then be permanently
      // unfundable — AWAITING_FUNDING tasks can no longer be edited back to
      // a valid budget (only DRAFT tasks can) — so this is rejected at
      // input validation rather than discovered later as a stuck task
      // (Codex review, T-605 round 2, P1).
      return BigInt(value) > 0n;
    },
    { message: "预算必须大于 0" },
  );

// `deliveryDeadline` is stored as TIMESTAMPTZ (0005_create_tasks.sql).
// Accepted as an ISO datetime string and required to be strictly in the
// future: rejecting a past deadline at draft-creation time is a basic input
// sanity check (a task that's already overdue before it's ever published
// serves no one), not a business rule invented beyond F-601/AC-601's "含
// ...截止时间" requirement. If this refinement turns out to conflict with a
// later Feature's editing flow (e.g. re-saving an already-late draft), that
// would surface as a design conflict for design.md to resolve, not evidence
// this check was wrong to add at the boundary.
const DELIVERY_DEADLINE_SCHEMA = z
  .string()
  .datetime({ message: "截止时间必须是合法的 ISO 8601 时间字符串" })
  .refine((value) => new Date(value).getTime() > Date.now(), "截止时间必须晚于当前时间");

/**
 * F-601: everything `POST /tasks/drafts` accepts. `requesterAddress` is
 * deliberately NOT a field here — it comes from the authenticated session
 * (`request.address` via `app.requireSession`), matching agents/schema.ts's
 * `ownerAddress` omission for `createAgentSchema`.
 */
export const createDraftSchema = z.object({
  category: CATEGORY_SCHEMA,
  skillTags: z.array(SKILL_TAG_SCHEMA).max(20).default([]),
  title: TITLE_SCHEMA,
  description: DESCRIPTION_SCHEMA,
  budget: BUDGET_SCHEMA,
  deliveryDeadline: DELIVERY_DEADLINE_SCHEMA,
});

export type CreateDraftInput = z.infer<typeof createDraftSchema>;

/**
 * F-602: `PATCH /tasks/:taskId/draft` body — `Partial<CreateDraftInput>`
 * (design.md's interface contract). Unlike agents/schema.ts's
 * updateAgentSchema, no field here accepts an explicit `null`: every field
 * of a task draft is required at creation (F-601/AC-601), so there is no
 * "clear this field" scenario to distinguish from "don't change this
 * field" — a key genuinely absent from the request body is the only way to
 * leave a field untouched.
 */
export const updateDraftSchema = z.object({
  category: CATEGORY_SCHEMA.optional(),
  skillTags: z.array(SKILL_TAG_SCHEMA).max(20).optional(),
  title: TITLE_SCHEMA.optional(),
  description: DESCRIPTION_SCHEMA.optional(),
  budget: BUDGET_SCHEMA.optional(),
  deliveryDeadline: DELIVERY_DEADLINE_SCHEMA.optional(),
});

export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

export const taskIdParamSchema = z.object({
  taskId: z.string().uuid("taskId 必须是合法的 UUID"),
});

// Same lowercase-0x-hex40 shape as agents/schema.ts's ETH_ADDRESS_SCHEMA —
// `requester` filters `tasks.requester_address`, which is stored lowercased
// (auth/nonce.store.ts's normalizeAddress). Accepted case-insensitively here
// (a caller may pass a checksummed address) and normalized once at the
// service boundary (service.ts), matching this file's fundingVerificationSchema
// comment on the same TX_HASH_PATTERN precedent.
const REQUESTER_ADDRESS_SCHEMA = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "requester 必须是合法的以太坊地址");

/**
 * T-605: `GET /tasks` query params. Mirrors agents/schema.ts's
 * listAgentsQuerySchema shape (page/pageSize coercion + defaults + 20-item
 * ceiling — F-608's "分页默认每页不超过 20 条").
 *
 * `status` accepts exactly one of the 9 `tasks.status` values (this
 * migration's `tasks_status_check` CHECK constraint) — not a free string —
 * so an invalid value is rejected at the API boundary rather than silently
 * matching zero rows.
 *
 * `requester` is a plain query param here, not read from the session by
 * this schema — but it is NOT an unconditional bypass either (Codex
 * review, T-605 round 1, P1, fixed after an earlier version of this
 * comment incorrectly reasoned it could be). For any PUBLISHED task
 * (OPEN and later), `requester=<any address>` just narrows a public
 * listing, the same way `category`/`skillTag` do — that part of the
 * original reasoning still holds, since a requester address isn't secret
 * and every published task is already visible via the plain market query.
 * But `service.ts`'s `listTasksForMarket` — not this schema — additionally
 * checks whether the caller's actual session address (if any) matches
 * `requester` exactly before including that address's DRAFT/
 * AWAITING_FUNDING tasks at all; an anonymous caller, or one asking about
 * a different address, only ever gets the published-only view no matter
 * what `requester`/`status` combination they pass. See
 * `ListTasksFilter.restrictToPublicStatuses` (repository.ts) for where
 * that decision is actually enforced.
 */
export const listTasksQuerySchema = z.object({
  requester: REQUESTER_ADDRESS_SCHEMA.optional(),
  status: z
    .enum([
      "DRAFT",
      "AWAITING_FUNDING",
      "OPEN",
      "ACCEPTED",
      "SUBMITTED",
      "DISPUTED",
      "RELEASED",
      "REFUNDED",
      "CANCELLED",
    ])
    .optional(),
  category: z.string().trim().min(1).max(100).optional(),
  skillTag: z.string().trim().min(1).max(50).optional(),
  // `page` is bounded (unlike agents/schema.ts's listAgentsQuerySchema,
  // which has the same latent gap this fixes here — out of this Task's
  // scope to touch) so `(page - 1) * pageSize` (repository.ts's `listTasks`
  // OFFSET) can never approach PostgreSQL's int4 range. Without a ceiling,
  // a page value like `1e21` would pass `.int()` (a JS number can represent
  // integers that large, just not exactly) and produce an OFFSET that
  // errors at the database instead of being rejected as a 400 (Codex
  // review, T-605 round 2, P2). 1,000,000 comfortably covers any real
  // pagination UI while keeping the worst-case offset (999999 * 20 ≈ 20M)
  // far inside int4's ~2.1B ceiling.
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20),
});

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

// Same 32-byte hex shape as `chain_transactions.tx_hash`'s own CHECK
// constraint (0005_create_tasks.sql: `tx_hash ~ '^0x[0-9a-f]{64}$'`), but
// case-insensitive here: the request body comes from the caller (a wallet
// client), which is free to report a transaction hash in any case, while
// the database column only ever stores the lowercased form. Normalizing to
// lowercase happens once, at the service boundary (service.ts), matching
// `checkTransactionNotUsed`'s own normalization — this schema's job is only
// to reject a value that could never be a valid hash, not to normalize it.
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * F-604/F-605: `POST /tasks/:taskId/funding-verifications` body. `txHash`
 * is the only client-supplied field — every value tx-verifier.ts's
 * `verifyFundingTransaction` compares against (requester, token, budget,
 * deadline, `taskIdOnChain`) is read from `tasks`/derived server-side, so
 * this schema never accepts any of them as request input (a client could
 * otherwise submit a mismatched set of "expected" values to try to sneak a
 * valid-looking request past validation).
 */
export const fundingVerificationSchema = z.object({
  txHash: z.string().trim().regex(TX_HASH_PATTERN, "txHash 必须是合法的 0x 前缀 32 字节哈希"),
});

export type FundingVerificationInput = z.infer<typeof fundingVerificationSchema>;
