import { z } from "zod";
import { MAX_USER_MESSAGE_LENGTH } from "./intent-classifier.js";

/**
 * Feature 22 (ai-customer-service), T-2204. `sessionId` is a
 * client-generated, opaque correlation id (e.g. a browser-local UUID the
 * chat widget keeps in `localStorage`) — it lets an anonymous visitor's
 * frontend recognize "this is the same browsing session" across page
 * loads, but is never used for any authorization decision (that's what
 * `actor_address`, derived server-side from the session cookie, is for —
 * see routes.ts's own doc comment on why the two are kept separate).
 */
export const createConversationSchema = z.object({
  sessionId: z.string().trim().min(1, "sessionId 不能为空").max(200, "sessionId 过长"),
});

export const conversationIdParamSchema = z.object({
  id: z.string().uuid(),
});

/** Reuses `intent-classifier.ts`'s own `MAX_USER_MESSAGE_LENGTH` — the
 * exact same real bound `classifyIntent`/`generateAnswer` already enforce
 * internally, so a message this endpoint accepts is never one
 * `generateAnswer` would immediately reject anyway. Not a second,
 * independently-chosen number. */
export const sendMessageSchema = z.object({
  message: z.string().trim().min(1, "消息内容不能为空").max(MAX_USER_MESSAGE_LENGTH, "消息过长"),
});

/**
 * N4 real finding (round 2, T-2204, P1): `POST
 * /admin/customer-service/conversations/:id/reply` — the missing write
 * side of "人工客服接手对话继续处理" (F-2205's own user story). Same length
 * bound as a real user message — an operator's real reply is not exempt
 * from the same sanity ceiling.
 */
export const humanReplySchema = z.object({
  message: z.string().trim().min(1, "回复内容不能为空").max(MAX_USER_MESSAGE_LENGTH, "回复过长"),
});

/** `GET /admin/customer-service/conversations`'s own query params — defaults
 * to the literal hand-off queue (see `conversation-repository.ts`'s
 * `listConversationsForAdminQueue` doc comment); `?escalatedOnly=false`
 * opts into listing every conversation instead. `before` is the opaque
 * cursor `nextCursor` from a prior page's response (N4 real finding, round
 * 1, T-2204: a flat cap with no pagination permanently hid conversations
 * older than the cap — see that function's own doc comment). */
export const adminConversationQueueQuerySchema = z.object({
  escalatedOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  beforeCreatedAt: z.string().datetime().optional(),
  beforeId: z.string().uuid().optional(),
});
