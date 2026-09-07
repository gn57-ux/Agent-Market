import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { formatZodError } from "../../shared/zod-error.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import { SESSION_COOKIE_NAME } from "../auth/session.middleware.js";
import { verifySession } from "../auth/session.service.js";
import { generateAnswer, type AnswerGenerationResult } from "./answer-generator.js";
import {
  appendMessage,
  createConversation,
  getConversationById,
  listConversationsForAdminQueue,
  listMessagesByConversation,
  markConversationEscalated,
  setConversationIntent,
  type ConversationRow,
} from "./conversation-repository.js";
import {
  adminConversationQueueQuerySchema,
  conversationIdParamSchema,
  createConversationSchema,
  humanReplySchema,
  sendMessageSchema,
} from "./schema.js";

/**
 * Feature 22 (ai-customer-service), T-2204 (F-2205). Wires T-2200-T-2203's
 * pure `generateAnswer` decision logic to real persistence
 * (`conversation-repository.ts`) and adds the human-escalation surface
 * design.md's "接口契约（草案）" describes.
 *
 * Decision (this Task, documented since design.md leaves it open): a
 * conversation is created via its own explicit `POST
 * /customer-service/conversations` call, not lazily on first message.
 * This keeps "who owns this conversation" a single, fixed fact recorded
 * ONCE at creation time (see `conversation-repository.ts`'s
 * `createConversation` doc comment) rather than something a message-send
 * handler would need to "claim" on first use — simpler state machine, and
 * it mirrors how every other resource-with-sub-resources in this codebase
 * (e.g. `tasks` → `deliverables`) is modeled: create the parent, then act
 * on it by id.
 */

/**
 * Same "best-effort, never 401" session lookup `disputes/routes.ts`'s
 * `readOptionalSessionAddress` and `agents/routes.ts`'s
 * `getOptionalSessionAddress` already establish — deliberately
 * re-declared per module rather than shared/exported, matching this
 * codebase's existing convention for this exact helper (see
 * `disputes/routes.ts`'s own comment on `requireSessionAddress` for the
 * same per-module-duplication note). An absent, malformed, or expired
 * session resolves to `null` (anonymous), same as if no cookie were sent —
 * this module's whole point is that both logged-in and anonymous visitors
 * are legitimate customer-service callers (F-2205/`generateAnswer`'s own
 * `actorAddress: string | null` contract).
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

/**
 * F-2206/ownership isolation: a conversation's `actor_address` (fixed at
 * creation time) and the CURRENT caller's own session address must match —
 * `null === null` (two anonymous parties) is treated as a match (there is
 * no stronger identity to check an anonymous conversation against; real
 * protection for that case is the conversation id's own unguessability, a
 * UUIDv4, not an ownership comparison — same reasoning this Task's own
 * spec explicitly calls out: "an anonymous caller escalating an anonymous
 * conversation is fine"). Any other mismatch (different logged-in address,
 * or one side logged in and the other not) is rejected. Used by BOTH the
 * message-send and the explicit-escalate endpoints — the same isolation
 * discipline T-2203 already established for personalized answers must
 * hold for "can this caller touch this conversation at all," not just for
 * "can this caller read another user's task status."
 */
function callerOwnsConversation(
  conversation: ConversationRow,
  callerAddress: string | null,
): boolean {
  const conversationOwner = conversation.actorAddress
    ? normalizeAddress(conversation.actorAddress)
    : null;
  const caller = callerAddress ? normalizeAddress(callerAddress) : null;
  return conversationOwner === caller;
}

function serializeConversation(conversation: ConversationRow) {
  return {
    id: conversation.id,
    sessionId: conversation.sessionId,
    actorAddress: conversation.actorAddress,
    intent: conversation.intent,
    escalatedToHuman: conversation.escalatedToHuman,
    createdAt: conversation.createdAt.toISOString(),
  };
}

/** The generic, non-content-specific fallback used ONLY when `generateAnswer`
 * itself throws (an unexpected, non-`IntentClassifierError` failure it
 * doesn't already catch internally — see its own doc comment: every
 * documented downstream-service fault already degrades to a returned
 * result, never a thrown error, so this is a defensive last resort, not the
 * primary escalation path). F-2210: a customer-service failure must
 * degrade to an honest answer, never an unhandled 500 that loses the
 * user's already-persisted message. Not the same literal string as
 * `answer-generator.ts`'s own private `ESCALATION_ANSWER` — that constant
 * is intentionally not exported (this module's own concern, kept
 * separate).
 */
const UNEXPECTED_FAILURE_ANSWER = "很抱歉，客服系统暂时出现问题，已为您转接人工客服处理。";

/**
 * N4 real finding (round 1, T-2204, P1): every message send runs a real
 * local Ollama classification + embedding + generation chain — none of it
 * requires a session, so an anonymous caller could repeatedly hit this
 * endpoint to exhaust local Ollama/DB resources with zero cost to
 * themselves (F-2210's own concern, from the other direction: the
 * customer-service module itself must not become the abuse vector that
 * starves shared local-model/DB capacity other Features depend on).
 * `@fastify/rate-limit` (the official Fastify plugin, not a hand-rolled
 * counter — this repo has no existing per-request rate-limit convention to
 * follow), registered with `global: false` and opted into ONLY by the
 * message-send route below via its own `config.rateLimit` — conversation
 * creation, escalation, and the admin endpoints are cheap DB operations,
 * not the real resource-exhaustion vector this finding is about, and a
 * global limit shared across every route in this module needlessly
 * throttles those too. Keyed by the caller's IP (the plugin's own
 * default — the one identity every caller has, logged-in or not). 30
 * requests/minute is a generous ceiling for a genuine human chatting.
 *
 * This function is `async` (unlike this codebase's other
 * `register*Routes` functions) purely because of a real, verified
 * Fastify/avvio ordering hazard found while adding the fix above: a
 * fire-and-forget (`void app.register(rateLimit, ...)`) plugin
 * registration made one encapsulation level deep (this function is
 * itself called from inside app.ts's own
 * `app.register(async (instance) => ...)` wrapper) does not reliably
 * finish wiring its `onRequest` hook onto `app` before this function's
 * own synchronous `app.post(...)` calls run — the rate limiter silently
 * never triggers (no `x-ratelimit-*` headers, no 429, ever), verified
 * directly against this exact two-levels-deep nesting shape. `await`ing
 * the registration call resolves the ordering correctly. Callers MUST
 * await this function (see app.ts's own updated registration).
 */
export async function registerCustomerServiceRoutes(
  app: FastifyInstance,
  pool: Pool,
): Promise<void> {
  // `global: false`: only the route(s) below that opt in via their own
  // `config.rateLimit` are limited — conversation creation, escalation,
  // and every admin endpoint are cheap DB operations, not the resource-
  // exhaustion vector the N4 finding (round 1) identified (that finding's
  // own wording: "每次请求都会执行本地模型分类、检索及生成" — specifically the
  // message-send endpoint's real Ollama chain, not this module's other,
  // cheap routes).
  await app.register(rateLimit, { global: false });

  app.post("/customer-service/conversations", async (request, reply) => {
    const bodyParsed = createConversationSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
    }
    const actorAddress = await readOptionalSessionAddress(request, pool);
    const conversation = await createConversation(pool, {
      sessionId: bodyParsed.data.sessionId,
      actorAddress,
    });
    return reply.status(201).send({ conversation: serializeConversation(conversation) });
  });

  app.post(
    "/customer-service/conversations/:id/messages",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const paramsParsed = conversationIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = sendMessageSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }

      const conversation = await getConversationById(pool, paramsParsed.data.id);
      if (!conversation) {
        return reply.status(404).send({ error: { message: "未找到该客服会话。" } });
      }

      const actorAddress = await readOptionalSessionAddress(request, pool);
      if (!callerOwnsConversation(conversation, actorAddress)) {
        return reply.status(403).send({ error: { message: "无权访问该客服会话。" } });
      }

      await appendMessage(pool, {
        conversationId: conversation.id,
        role: "USER",
        content: bodyParsed.data.message,
      });

      // Decision (documented here, not a formal single SQL transaction): the
      // user's message is persisted BEFORE calling `generateAnswer` so a
      // downstream failure never loses what the user actually said.
      // `generateAnswer` itself makes a real external network call (local
      // Ollama, up to its own 30s timeout) — holding a single checked-out
      // `pg` client/transaction open for that entire external round trip
      // would tie up a pool connection for no correctness benefit (every
      // write below is independently safe to apply as soon as it's known:
      // the assistant message, the conversation's `intent`, and the
      // escalation flag are three separate, idempotent-to-reapply facts, not
      // a multi-step invariant that could be left half-applied in a way that
      // corrupts anything). "Same transaction/flow" is satisfied as "one
      // request handler's own sequential flow always performs all of them
      // together," not as a hard ACID transaction.
      let result: AnswerGenerationResult;
      try {
        result = await generateAnswer(pool, bodyParsed.data.message, actorAddress);
      } catch {
        result = {
          intent: "UNHANDLED",
          answer: UNEXPECTED_FAILURE_ANSWER,
          citedKbArticleIds: [],
          escalate: true,
        };
      }

      await appendMessage(pool, {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: result.answer,
        citedKbArticleIds: result.citedKbArticleIds,
      });
      await setConversationIntent(pool, conversation.id, result.intent);
      if (result.escalate) {
        await markConversationEscalated(pool, conversation.id);
      }

      // N4 real finding (round 2, T-2204, P2): `escalated_to_human` is a
      // one-way flag (`markConversationEscalated`'s own doc comment) — a
      // conversation escalated by an EARLIER turn (or the explicit
      // `/escalate` endpoint) stays escalated even if THIS turn's own
      // `generateAnswer` call happens to answer confidently
      // (`result.escalate === false`). Returning the bare `result.escalate`
      // here would contradict the real persisted state and could make a
      // client believe a still-escalated conversation had exited the human
      // queue. `result.escalate ||` the conversation's already-known prior
      // state covers the case cheaply without a second DB read (a
      // conversation can only ever become escalated, never un-escalated —
      // see `markConversationEscalated`'s idempotent-one-way contract — so
      // this turn's own already-loaded `conversation.escalatedToHuman`,
      // fetched before this turn's own write, is exactly what's needed).
      return reply.status(200).send({
        intent: result.intent,
        answer: result.answer,
        citedKbArticleIds: result.citedKbArticleIds,
        escalated: result.escalate || conversation.escalatedToHuman,
      });
    },
  );

  // F-2205: "或用户主动要求" — regardless of what `generateAnswer` would have
  // decided, a caller can always demand human hand-off directly. Decision
  // (documented here): this just flips `escalated_to_human`, no synthetic
  // marker message is appended — `role` is constrained to
  // `USER`/`ASSISTANT`/`HUMAN_AGENT` (0044's own CHECK constraint), and
  // inventing a fake `HUMAN_AGENT` message to announce "a human hasn't
  // actually joined yet" would misrepresent the transcript to whichever
  // operator later reads it via the admin endpoint. The flag itself, plus
  // `GET .../messages`'s real transcript, is the complete, honest record.
  app.post("/customer-service/conversations/:id/escalate", async (request, reply) => {
    const paramsParsed = conversationIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
    }

    const conversation = await getConversationById(pool, paramsParsed.data.id);
    if (!conversation) {
      return reply.status(404).send({ error: { message: "未找到该客服会话。" } });
    }

    const actorAddress = await readOptionalSessionAddress(request, pool);
    if (!callerOwnsConversation(conversation, actorAddress)) {
      return reply.status(403).send({ error: { message: "无权访问该客服会话。" } });
    }

    await markConversationEscalated(pool, conversation.id);
    return reply.status(200).send({ escalated: true });
  });

  // F-2205's human hand-off queue, design.md's "复用 Feature 16 的管理员权限
  // 模型" — `app.requireAdmin` verbatim, same as every other admin-routes.ts
  // in this codebase (e.g. arbitration/admin-routes.ts).
  app.get(
    "/admin/customer-service/conversations",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const queryParsed = adminConversationQueueQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(queryParsed.error) } });
      }
      const escalatedOnly = queryParsed.data.escalatedOnly !== "false";
      const { beforeCreatedAt, beforeId, limit } = queryParsed.data;
      const before =
        beforeCreatedAt && beforeId ? { createdAt: beforeCreatedAt, id: beforeId } : undefined;
      const page = await listConversationsForAdminQueue(pool, { escalatedOnly, limit, before });
      return reply.status(200).send({
        conversations: page.conversations.map(serializeConversation),
        nextCursor: page.nextCursor,
      });
    },
  );

  // F-2205 "转接过程保留完整对话上下文": the FULL, ordered transcript for one
  // conversation — never truncated — so an operator picking up a hand-off
  // has everything the bot (and the user) already said.
  app.get(
    "/admin/customer-service/conversations/:id/messages",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = conversationIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const conversation = await getConversationById(pool, paramsParsed.data.id);
      if (!conversation) {
        return reply.status(404).send({ error: { message: "未找到该客服会话。" } });
      }
      const messages = await listMessagesByConversation(pool, conversation.id);
      return reply.status(200).send({
        conversation: serializeConversation(conversation),
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          citedKbArticleIds: message.citedKbArticleIds,
          createdAt: message.createdAt.toISOString(),
        })),
      });
    },
  );

  // N4 real finding (round 2, T-2204, P1): the admin surface was
  // previously read-only — an operator could SEE a hand-off queue but had
  // no way to actually "接手对话继续处理" (F-2205's own explicit user
  // story). This is the missing write side: a real `HUMAN_AGENT` reply,
  // appended to the same transcript `GET .../messages` already returns in
  // full and in order, so the user sees the human's answer exactly where
  // their own message was. Does NOT require the conversation to already
  // be `escalated_to_human` (an admin monitoring/auditing a
  // not-yet-escalated conversation may still legitimately want to step in
  // directly) but DOES mark it escalated as a side effect — a human
  // agent has now genuinely joined, which is a stronger, more definitive
  // signal than any bot-side heuristic.
  app.post(
    "/admin/customer-service/conversations/:id/reply",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = conversationIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = humanReplySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const conversation = await getConversationById(pool, paramsParsed.data.id);
      if (!conversation) {
        return reply.status(404).send({ error: { message: "未找到该客服会话。" } });
      }

      const message = await appendMessage(pool, {
        conversationId: conversation.id,
        role: "HUMAN_AGENT",
        content: bodyParsed.data.message,
      });
      await markConversationEscalated(pool, conversation.id);

      return reply.status(201).send({
        message: {
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
        },
      });
    },
  );
}
