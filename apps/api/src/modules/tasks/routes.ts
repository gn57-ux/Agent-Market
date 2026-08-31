import type { ErrorCode } from "@agent-market/domain";
import type { FastifyReply, FastifyRequest, FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { verifySession } from "../auth/session.service.js";
import { createChainRpcClient } from "../chain/rpc.client.js";
import { embedTaskOnSave } from "../embeddings/embed-on-save.js";
import { formatZodError } from "../../shared/zod-error.js";
import type {
  FundingIntentResult,
  FundingVerificationServiceResult,
  TaskAcceptanceVerificationServiceResult,
  TaskDisputeOpenVerificationServiceResult,
  TaskDisputeResolveVerificationServiceResult,
  TaskDraftMutationResult,
  TaskResultSubmissionVerificationServiceResult,
  TaskSettlementVerificationServiceResult,
} from "./service.js";
import type { TaskRow } from "./repository.js";
import {
  createDraft,
  createFundingIntent,
  getTaskDetail,
  getTaskStateHistory,
  listTasksForMarket,
  updateDraft,
  verifyAcceptance,
  verifyDisputeOpen,
  verifyDisputeResolution,
  verifyFunding,
  verifyResultSubmission,
  verifySettlement,
} from "./service.js";
import {
  createDraftSchema,
  fundingVerificationSchema,
  listTasksQuerySchema,
  taskIdParamSchema,
  updateDraftSchema,
} from "./schema.js";

// Typed against @agent-market/domain's ErrorCode (PRD §11.4 single source
// of truth), matching auth/routes.ts's WALLET_SIGNATURE_INVALID pattern —
// a rename/removal in error-codes.ts fails this file to typecheck instead
// of silently drifting from a hardcoded string literal (Codex review,
// T-602 round 1, P2: the literal previously declared here duplicated the
// shared code with no compile-time link back to it).
const TASK_STATE_CONFLICT: ErrorCode = "TASK_STATE_CONFLICT";
const IDEMPOTENCY_KEY_CONFLICT: ErrorCode = "IDEMPOTENCY_KEY_CONFLICT";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

// Matches session.middleware.ts's own SESSION_COOKIE_NAME literal (also
// re-declared in auth/routes.ts) — not exported from either module to
// import here, so this follows the same existing local-constant pattern
// rather than introducing a new cross-module dependency for one string.
const SESSION_COOKIE_NAME = "session_token";

/**
 * `GET /tasks`, `GET /tasks/:taskId`, and `GET /tasks/:taskId/history` are
 * public reads (no `app.requireSession` preHandler — a 401 would break
 * anonymous market browsing), but they still need to know the caller's
 * identity WHEN a valid session is present, to decide whether DRAFT/
 * AWAITING_FUNDING tasks belonging to that address may be shown (Codex
 * review, T-605 round 1, P1). This reads the session cookie the same way
 * `app.requireSession` does, but never 401s — an absent, malformed, or
 * expired session simply resolves to `null` (anonymous), same as if no
 * cookie were sent at all.
 */
async function readOptionalSessionAddress(
  request: FastifyRequest,
  pool: Pool,
): Promise<string | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }
  const verified = await verifySession(pool, token);
  return verified?.address ?? null;
}

/** Response shape for the PATCH draft-edit endpoint (F-602). `budget` comes
 * back from `pg` as a string (NUMERIC columns
 * aren't safely representable as JS `number`) — passed through as-is rather
 * than `Number()`-coerced, mirroring agents/routes.ts's toAgentSummaryJson. */
function toTaskDraftJson(task: TaskRow) {
  return {
    taskId: task.id,
    requesterAddress: task.requesterAddress,
    category: task.category,
    title: task.title,
    description: task.description,
    budget: task.budget,
    token: task.token,
    deliveryDeadline: task.deliveryDeadline.toISOString(),
    skillTags: task.skillTags,
    expertType: task.expertType,
    status: task.status,
    fundingTxHash: task.fundingTxHash,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    // T-805: exposes the `accepted_agent_address`/`accepted_at` columns
    // T-801 already writes atomically with the OPEN→ACCEPTED transition —
    // both `null` until a task is accepted.
    acceptedAgentAddress: task.acceptedAgentAddress,
    acceptedAt: task.acceptedAt?.toISOString() ?? null,
  };
}

/**
 * Reads the `Idempotency-Key` request header, matching Fastify's
 * lowercased-header convention. Returns `null` only for "no key supplied"
 * (F-601 treats the key as optional — a caller not needing idempotency
 * simply omits the header) or a header present but blank after trimming.
 * A non-blank key is returned as-is regardless of length: `tasks.
 * idempotency_key` is an unconstrained `TEXT` column (0005_create_tasks.sql)
 * with no length limit design.md prescribes, so silently discarding a long
 * key here would silently disable the caller's idempotency guarantee — a
 * retried request would then create a second task instead of hitting the
 * unique-constraint fast path (Codex review, T-602 round 1, P2).
 */
function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Same pattern as agents/routes.ts's `requireSessionAddress`: reads
 * `request.address` (populated by `app.requireSession`) without a
 * non-null assertion. The 401 branch here is defensive — not expected to
 * actually trigger given `requireSession` already ran as this route's
 * preHandler.
 */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

/** Shared 404/403/409 handling for updateDraft's not_found/forbidden/
 * not_draft results (F-602). `not_draft` carries the domain error code
 * `TASK_STATE_CONFLICT` (packages/domain/src/error-codes.ts) so frontend
 * error handling can switch on it rather than string-matching a message. */
function sendMutationFailure(
  reply: FastifyReply,
  result: Extract<TaskDraftMutationResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "forbidden") {
    return reply.status(403).send({ error: { message: "只有任务归属地址可以编辑此草稿。" } });
  }
  return reply.status(409).send({
    error: {
      code: TASK_STATE_CONFLICT,
      message: "任务已不处于草稿状态，无法编辑。",
    },
  });
}

/** Shared 404/403/409 handling for `createFundingIntent`'s not_found/
 * forbidden/conflict results (F-604) — same status-code shape as
 * `sendMutationFailure` above, kept as its own function because the
 * `conflict` message here is specific to funding (not "no longer a
 * draft"). */
function sendFundingIntentFailure(
  reply: FastifyReply,
  result: Extract<FundingIntentResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "forbidden") {
    return reply.status(403).send({ error: { message: "只有任务归属地址可以锁定预算。" } });
  }
  if (result.reason === "expired_deadline") {
    return reply.status(400).send({
      error: { message: "任务截止时间已过，请先编辑草稿延长截止时间后再发起资金锁定。" },
    });
  }
  return reply.status(409).send({
    error: {
      code: TASK_STATE_CONFLICT,
      message: `任务当前状态为 ${result.currentStatus}，无法发起资金锁定。`,
    },
  });
}

/**
 * F-606's error-code → HTTP-status mapping for `funding-verifications`.
 * Each choice:
 *
 * - `TRANSACTION_NOT_FOUND` / `FUNDING_EVENT_MISMATCH` / `CHAIN_UNSUPPORTED`
 *   → 400: the submitted `txHash` (or the transaction it points to) is
 *   provably wrong for this request — a different hash, a different chain,
 *   or a receipt whose contents don't match the draft. Retrying the exact
 *   same request can't succeed, so this is a client error, not a transient
 *   one.
 * - `TRANSACTION_NOT_CONFIRMED` / `RPC_TEMPORARILY_UNAVAILABLE` → 202
 *   Accepted: F-606 explicitly requires the task stay "待确认" (pending),
 *   not "failed", for both of these — the request was valid and
 *   understood, the outcome just isn't final yet. 202 is the closest
 *   standard status for "accepted, not yet complete, no error" — a 4xx
 *   would incorrectly suggest the client should change something before
 *   retrying, a 200 would incorrectly suggest funding is already done, and
 *   a 5xx would suggest this server itself is broken (RPC being flaky is
 *   an external dependency issue, not this API failing).
 * - `TRANSACTION_ALREADY_USED` → 409: a real conflict — the resource
 *   (`chain_id`, `tx_hash`) is already bound to a different task.
 */
function fundingErrorStatus(code: ErrorCode): number {
  switch (code) {
    case "TRANSACTION_NOT_FOUND":
    case "FUNDING_EVENT_MISMATCH":
    case "CHAIN_UNSUPPORTED":
      return 400;
    case "TRANSACTION_NOT_CONFIRMED":
    case "RPC_TEMPORARILY_UNAVAILABLE":
      return 202;
    case "TRANSACTION_ALREADY_USED":
      return 409;
    default:
      return 400;
  }
}

/** Shared 404/403/409/{4xx,202} handling for `verifyFunding`'s failure
 * outcomes. `chain_error` carries the `ErrorCode` straight from
 * `tx-verifier.ts` — this function never invents its own message for that
 * branch, it passes the verifier's own `message` through, matching F-605's
 * intent that the verifier owns the full explanation of *why* a
 * transaction was rejected. */
function sendFundingVerificationFailure(
  reply: FastifyReply,
  result: Extract<FundingVerificationServiceResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "forbidden") {
    return reply.status(403).send({ error: { message: "只有任务归属地址可以提交资金复核。" } });
  }
  if (result.reason === "conflict") {
    return reply.status(409).send({
      error: {
        code: TASK_STATE_CONFLICT,
        message: `任务当前状态为 ${result.currentStatus}，无法复核资金交易。`,
      },
    });
  }
  return reply
    .status(fundingErrorStatus(result.code))
    .send({ error: { code: result.code, message: result.message } });
}

/** T-801: `POST /tasks/:taskId/acceptance-verifications` failure handling —
 * reuses `fundingErrorStatus`'s exact ErrorCode→HTTP mapping (the mapping
 * is about what each *code* means, not which endpoint produced it), so
 * this only needs its own 404/409 message text and the passthrough
 * `chain_error` branch. No `forbidden` branch: unlike `verifyFunding`,
 * `verifyAcceptance` never returns one — see its own doc comment
 * (service.ts) for why ownership is enforced through verification instead
 * of a pre-check. */
function sendAcceptanceVerificationFailure(
  reply: FastifyReply,
  result: Extract<TaskAcceptanceVerificationServiceResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "conflict") {
    return reply.status(409).send({
      error: {
        code: TASK_STATE_CONFLICT,
        message: `任务当前状态为 ${result.currentStatus}，无法复核接单交易。`,
      },
    });
  }
  return reply
    .status(fundingErrorStatus(result.code))
    .send({ error: { code: result.code, message: result.message } });
}

/** T-905: `POST /tasks/:taskId/result-verifications` failure handling —
 * same structure as `sendAcceptanceVerificationFailure` above (reuses
 * `fundingErrorStatus`'s exact ErrorCode→HTTP mapping), only its own
 * 404/409 message text differs. No `forbidden` branch: `verifyResultSubmission`
 * never returns one, for the same reason `verifyAcceptance` doesn't — see
 * that function's own doc comment (service.ts). */
function sendResultSubmissionVerificationFailure(
  reply: FastifyReply,
  result: Extract<TaskResultSubmissionVerificationServiceResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "conflict") {
    return reply.status(409).send({
      error: {
        code: TASK_STATE_CONFLICT,
        message: `任务当前状态为 ${result.currentStatus}，无法复核成果提交交易。`,
      },
    });
  }
  return reply
    .status(fundingErrorStatus(result.code))
    .send({ error: { code: result.code, message: result.message } });
}

/** T-1001: `POST /tasks/:taskId/settlement-verifications` failure handling —
 * same structure as `sendResultSubmissionVerificationFailure` above. No
 * `forbidden` branch: `verifySettlement` never returns one — see that
 * function's own doc comment (service.ts) for why no caller-identity
 * cross-check is needed here. */
function sendSettlementVerificationFailure(
  reply: FastifyReply,
  result: Extract<TaskSettlementVerificationServiceResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "conflict") {
    return reply.status(409).send({
      error: {
        code: TASK_STATE_CONFLICT,
        message: `任务当前状态为 ${result.currentStatus}，无法复核结算交易。`,
      },
    });
  }
  return reply
    .status(fundingErrorStatus(result.code))
    .send({ error: { code: result.code, message: result.message } });
}

/** T-1002: `POST /tasks/:taskId/dispute-open-verifications` failure
 * handling — same structure as `sendSettlementVerificationFailure` above. */
function sendDisputeOpenVerificationFailure(
  reply: FastifyReply,
  result: Extract<TaskDisputeOpenVerificationServiceResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "conflict") {
    return reply.status(409).send({
      error: {
        code: TASK_STATE_CONFLICT,
        message: `任务当前状态为 ${result.currentStatus}，无法复核发起争议交易。`,
      },
    });
  }
  return reply
    .status(fundingErrorStatus(result.code))
    .send({ error: { code: result.code, message: result.message } });
}

/** T-1002: `POST /tasks/:taskId/dispute-resolve-verifications` failure
 * handling — same structure as `sendSettlementVerificationFailure` above. */
function sendDisputeResolveVerificationFailure(
  reply: FastifyReply,
  result: Extract<TaskDisputeResolveVerificationServiceResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该任务。" } });
  }
  if (result.reason === "conflict") {
    return reply.status(409).send({
      error: {
        code: TASK_STATE_CONFLICT,
        message: `任务当前状态为 ${result.currentStatus}，无法复核仲裁裁决交易。`,
      },
    });
  }
  return reply
    .status(fundingErrorStatus(result.code))
    .send({ error: { code: result.code, message: result.message } });
}

/** T-605: `GET /tasks/:taskId/history` response shape — one entry per
 * `task_state_history` row, `occurredAt` ISO-formatted matching every other
 * timestamp field in this module (`toTaskDraftJson`). */
function toTaskHistoryEntryJson(entry: {
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  reason: string | null;
  occurredAt: Date;
}) {
  return {
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    actor: entry.actor,
    reason: entry.reason,
    occurredAt: entry.occurredAt.toISOString(),
  };
}

/**
 * Registers the F-601/F-602/T-605 task route surface. Wrapped in its own
 * `app.register(...)` at the call site (see app.ts), not called directly
 * after `buildApp()` returns: the session-protected routes below use
 * `app.requireSession` as a preHandler, and that decorator is only
 * guaranteed to exist once `registerSessionMiddleware`'s own registration
 * has finished — see session.middleware.ts's doc comment, and agents/
 * routes.ts's identical reasoning. `GET /tasks`, `GET /tasks/:taskId`, and
 * `GET /tasks/:taskId/history` don't use `app.requireSession` as a
 * preHandler (T-605): they're public reads, the same "no session required
 * to browse" contract `GET /agents`/`GET /agents/:agentId` already
 * established, and an anonymous caller must still see the public market.
 * They DO read the session opportunistically via
 * `readOptionalSessionAddress` — when present, it's what lets
 * `listTasksForMarket`/`getTaskDetail` decide whether the caller may see
 * DRAFT/AWAITING_FUNDING tasks that belong to them (Codex review, T-605
 * round 1, P1: `requester` on `GET /tasks` is a public filter over
 * PUBLISHED tasks only — never an unauthenticated bypass into anyone's
 * unpublished drafts).
 */
export function registerTasksRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/tasks", async (request, reply) => {
    const parsed = listTasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const viewerAddress = await readOptionalSessionAddress(request, pool);
    const { items, total } = await listTasksForMarket(pool, parsed.data, viewerAddress);
    return reply.send({
      items: items.map(toTaskDraftJson),
      total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  });

  app.get("/tasks/:taskId", async (request, reply) => {
    const parsed = taskIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const viewerAddress = await readOptionalSessionAddress(request, pool);
    const task = await getTaskDetail(pool, parsed.data.taskId, viewerAddress);
    if (!task) {
      return reply.status(404).send({ error: { message: "未找到该任务。" } });
    }
    return reply.send(toTaskDraftJson(task));
  });

  app.get("/tasks/:taskId/history", async (request, reply) => {
    const parsed = taskIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const viewerAddress = await readOptionalSessionAddress(request, pool);
    const task = await getTaskDetail(pool, parsed.data.taskId, viewerAddress);
    if (!task) {
      return reply.status(404).send({ error: { message: "未找到该任务。" } });
    }

    const history = await getTaskStateHistory(pool, parsed.data.taskId);
    return reply.send({ items: history.map(toTaskHistoryEntryJson) });
  });

  app.post("/tasks/drafts", { preHandler: app.requireSession }, async (request, reply) => {
    const parsed = createDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }

    const idempotencyKey = readIdempotencyKey(request);
    const result = await createDraft(pool, sessionAddress, parsed.data, idempotencyKey);

    // T-609 (Feature 14, F-1405): a same-key replay whose payload doesn't
    // match the original request is a client bug, not a legitimate retry —
    // reject it rather than silently returning the stale original as if
    // the new data had been accepted.
    if (!result.ok) {
      return reply.status(409).send({
        error: {
          code: IDEMPOTENCY_KEY_CONFLICT,
          message: "同一 Idempotency-Key 已用于一个字段不同的请求，拒绝创建。",
        },
      });
    }
    const { task, isNewlyCreated } = result;

    // F-1301/F-1303/T-1302: fire-and-forget, never awaited — see agents/
    // routes.ts's identical comment on POST /agents for the full reasoning.
    // Only fires on a genuine insert — an idempotent replay returns the same
    // unchanged row, and re-embedding it would let a client exhaust the
    // shared monthly budget purely by resending the same Idempotency-Key.
    // F-1303's "最多触发一次" is per save EVENT, not per HTTP request.
    if (isNewlyCreated) {
      void embedTaskOnSave(pool, task).catch(() => {});
    }

    return reply.status(201).send(toTaskDraftJson(task));
  });

  app.patch("/tasks/:taskId/draft", { preHandler: app.requireSession }, async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
    }
    const bodyParsed = updateDraftSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
    }
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }

    const result = await updateDraft(
      pool,
      sessionAddress,
      paramsParsed.data.taskId,
      bodyParsed.data,
    );
    if (!result.ok) {
      return sendMutationFailure(reply, result);
    }
    // F-1301/T-1302: see POST /tasks/drafts's identical comment above.
    void embedTaskOnSave(pool, result.task).catch(() => {});
    return reply.send(toTaskDraftJson(result.task));
  });

  app.post(
    "/tasks/:taskId/funding-intent",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const result = await createFundingIntent(pool, sessionAddress, paramsParsed.data.taskId);
      if (!result.ok) {
        return sendFundingIntentFailure(reply, result);
      }
      return reply.send(result.intent);
    },
  );

  app.post(
    "/tasks/:taskId/funding-verifications",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = fundingVerificationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      // A real, independent RPC client (BACKEND_RPC_URL) — never the
      // frontend wallet's provider (rpc.client.ts's own "独立 RPC"
      // reasoning). Constructed per-request rather than once at module
      // load so this route only requires BACKEND_RPC_URL to be set once a
      // request actually arrives, not at server boot.
      const rpc = createChainRpcClient();

      const result = await verifyFunding(
        pool,
        rpc,
        sessionAddress,
        paramsParsed.data.taskId,
        bodyParsed.data.txHash,
      );
      if (!result.ok) {
        return sendFundingVerificationFailure(reply, result);
      }
      return reply.send({ status: result.status, confirmations: result.confirmations });
    },
  );

  // T-801 (Feature 8, task capsule's confirmed scope decision #2): mirrors
  // `funding-verifications` above exactly — same body schema (`txHash`
  // only), same session requirement, same RPC-client construction pattern.
  // `fundingVerificationSchema` is reused as-is rather than a duplicate
  // "acceptance verification schema": both bodies are the identical
  // `{ txHash }` shape validated by the identical rule.
  app.post(
    "/tasks/:taskId/acceptance-verifications",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = fundingVerificationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      // A real, independent RPC client (BACKEND_RPC_URL) — same reasoning
      // as funding-verifications above: never the frontend wallet's
      // provider.
      const rpc = createChainRpcClient();

      const result = await verifyAcceptance(
        pool,
        rpc,
        sessionAddress,
        paramsParsed.data.taskId,
        bodyParsed.data.txHash,
      );
      if (!result.ok) {
        return sendAcceptanceVerificationFailure(reply, result);
      }
      return reply.send({ status: result.status, confirmations: result.confirmations });
    },
  );

  // T-905 (F-905): mirrors `acceptance-verifications` above exactly — same
  // body schema (`txHash` only, `fundingVerificationSchema` reused as-is),
  // same session requirement, same RPC-client construction pattern. No
  // explicit HTTP contract is spelled out in design.md's own interface
  // section (its `onEvent('ResultSubmitted', ...)` pseudocode is framed as
  // "无对外 HTTP 契约") — this endpoint is the same client-submits-txHash /
  // backend-independently-verifies shape this codebase already established
  // for both `funding-verifications` and `acceptance-verifications`
  // (Feature 6/8's `chain_events` mechanism T-905 is explicitly told to
  // reuse), not a new design.
  app.post(
    "/tasks/:taskId/result-verifications",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = fundingVerificationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      // A real, independent RPC client (BACKEND_RPC_URL) — same reasoning
      // as funding-verifications/acceptance-verifications above: never the
      // frontend wallet's provider.
      const rpc = createChainRpcClient();

      const result = await verifyResultSubmission(
        pool,
        rpc,
        sessionAddress,
        paramsParsed.data.taskId,
        bodyParsed.data.txHash,
      );
      if (!result.ok) {
        return sendResultSubmissionVerificationFailure(reply, result);
      }
      return reply.send({ status: result.status, confirmations: result.confirmations });
    },
  );

  // T-1001 (F-1001/F-1002): same client-submits-txHash / backend-
  // independently-verifies shape as result-verifications above — covers
  // all three of `approveResult`/`claimDeliveryTimeout`/
  // `finalizeReviewTimeout` (verifySettlement's own decoded-event
  // discriminant decides which one). Session-gated for consistency with
  // every other verification route in this file, even though
  // `verifySettlement` itself does not cross-check caller identity
  // (finalizeReviewTimeout is callable by anyone on-chain, so nothing
  // here would gain from restricting who may REPORT a real, independently
  // re-verified transaction).
  app.post(
    "/tasks/:taskId/settlement-verifications",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = fundingVerificationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const rpc = createChainRpcClient();

      const result = await verifySettlement(
        pool,
        rpc,
        paramsParsed.data.taskId,
        bodyParsed.data.txHash,
      );
      if (!result.ok) {
        return sendSettlementVerificationFailure(reply, result);
      }
      return reply.send({ status: result.status, confirmations: result.confirmations });
    },
  );

  // T-1002: `POST /tasks/:taskId/dispute-open-verifications` re-verifies a
  // DisputeOpened transaction directly against RPC and transitions
  // SUBMITTED -> DISPUTED. Session-gated for consistency with every other
  // verification route in this file; caller identity is not itself trusted
  // for correctness — verifyDisputeOpen cross-checks the decoded on-chain
  // evidenceHash against the already-recorded open dispute row instead.
  app.post(
    "/tasks/:taskId/dispute-open-verifications",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = fundingVerificationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const rpc = createChainRpcClient();

      const result = await verifyDisputeOpen(
        pool,
        rpc,
        paramsParsed.data.taskId,
        bodyParsed.data.txHash,
      );
      if (!result.ok) {
        return sendDisputeOpenVerificationFailure(reply, result);
      }
      return reply.send({ status: result.status, confirmations: result.confirmations });
    },
  );

  // T-1002: `POST /tasks/:taskId/dispute-resolve-verifications` re-verifies a
  // DisputeResolved transaction and transitions DISPUTED -> RELEASED or
  // REFUNDED depending on the decoded `supportAgent` flag. Session-gated
  // for consistency with every other verification route in this file, but
  // `sessionAddress` itself is NOT passed to `verifyDisputeResolution` —
  // `disputes.resolved_by`/`audit_logs.actor_address` are sourced from the
  // transaction's own verified signer instead (see service.ts's doc
  // comment; Codex review, T-1002 round 1, P1).
  app.post(
    "/tasks/:taskId/dispute-resolve-verifications",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = fundingVerificationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const rpc = createChainRpcClient();

      const result = await verifyDisputeResolution(
        pool,
        rpc,
        paramsParsed.data.taskId,
        bodyParsed.data.txHash,
      );
      if (!result.ok) {
        return sendDisputeResolveVerificationFailure(reply, result);
      }
      return reply.send({ status: result.status, confirmations: result.confirmations });
    },
  );
}
