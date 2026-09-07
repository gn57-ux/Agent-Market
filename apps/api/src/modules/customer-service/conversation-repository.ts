import type { Queryable } from "../../db/pool.js";

/**
 * Feature 22 (ai-customer-service), T-2204. This is the ONE module that
 * knows `customer_service_conversations`/`customer_service_messages`'
 * columns (CLAUDE.md 原则 6: 设计知识只能有一个归属) — `routes.ts` and every
 * future customer-service Task must go through the functions here, never
 * query either table directly.
 */

export interface ConversationRow {
  id: string;
  sessionId: string;
  actorAddress: string | null;
  intent: string | null;
  escalatedToHuman: boolean;
  createdAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: "USER" | "ASSISTANT" | "HUMAN_AGENT";
  content: string;
  citedKbArticleIds: string[];
  createdAt: Date;
}

interface ConversationDbRow {
  id: string;
  session_id: string;
  actor_address: string | null;
  intent: string | null;
  escalated_to_human: boolean;
  created_at: Date;
}

interface MessageDbRow {
  id: string;
  conversation_id: string;
  role: "USER" | "ASSISTANT" | "HUMAN_AGENT";
  content: string;
  cited_kb_article_ids: string[] | null;
  created_at: Date;
}

function toConversationRow(row: ConversationDbRow): ConversationRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    actorAddress: row.actor_address,
    intent: row.intent,
    escalatedToHuman: row.escalated_to_human,
    createdAt: row.created_at,
  };
}

function toMessageRow(row: MessageDbRow): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    citedKbArticleIds: row.cited_kb_article_ids ?? [],
    createdAt: row.created_at,
  };
}

/**
 * `routes.ts`'s decision (documented there): `actor_address` is captured
 * ONCE, at conversation-creation time, from whatever session (if any) is
 * active when the conversation is created — never re-derived or changed on
 * a later message. This is what makes the ownership check in
 * `conversationBelongsToActor` below meaningful: a conversation's owner is
 * fixed for its whole lifetime, not something a later request could
 * silently reassign.
 */
export async function createConversation(
  pool: Queryable,
  params: { sessionId: string; actorAddress: string | null },
): Promise<ConversationRow> {
  const { rows } = await pool.query<ConversationDbRow>(
    `INSERT INTO customer_service_conversations (session_id, actor_address)
     VALUES ($1, $2)
     RETURNING id, session_id, actor_address, intent, escalated_to_human, created_at`,
    [params.sessionId, params.actorAddress],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("客服会话创建失败：未返回记录。");
  }
  return toConversationRow(row);
}

export async function getConversationById(
  pool: Queryable,
  id: string,
): Promise<ConversationRow | null> {
  const { rows } = await pool.query<ConversationDbRow>(
    `SELECT id, session_id, actor_address, intent, escalated_to_human, created_at
     FROM customer_service_conversations
     WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toConversationRow(row) : null;
}

/**
 * F-2201/T-2202: the conversation's `intent` column tracks the
 * MOST-RECENTLY classified intent (a conversation can legitimately drift
 * across topics turn to turn) — not a first-message-only snapshot. Called
 * once per real user message, after `generateAnswer` has already produced
 * a classification for it.
 */
export async function setConversationIntent(
  pool: Queryable,
  conversationId: string,
  intent: string,
): Promise<void> {
  await pool.query(`UPDATE customer_service_conversations SET intent = $2 WHERE id = $1`, [
    conversationId,
    intent,
  ]);
}

/**
 * F-2205: flips the hand-off flag. Idempotent (`escalated_to_human = true`
 * unconditionally, no-op if already true) — both the automatic
 * (`generateAnswer`'s `escalate: true`) and the explicit
 * (`POST /customer-service/conversations/:id/escalate`) paths call this
 * same function, and either can legitimately fire after the other already
 * has (design.md's F-2205: "无法处理，或用户主动要求" are two independent
 * triggers for the same one-way state transition).
 */
export async function markConversationEscalated(
  pool: Queryable,
  conversationId: string,
): Promise<void> {
  await pool.query(
    `UPDATE customer_service_conversations SET escalated_to_human = true WHERE id = $1`,
    [conversationId],
  );
}

export async function appendMessage(
  pool: Queryable,
  params: {
    conversationId: string;
    role: "USER" | "ASSISTANT" | "HUMAN_AGENT";
    content: string;
    citedKbArticleIds?: string[];
  },
): Promise<MessageRow> {
  const { rows } = await pool.query<MessageDbRow>(
    `INSERT INTO customer_service_messages (conversation_id, role, content, cited_kb_article_ids)
     VALUES ($1, $2, $3, $4)
     RETURNING id, conversation_id, role, content, cited_kb_article_ids, created_at`,
    [
      params.conversationId,
      params.role,
      params.content,
      params.citedKbArticleIds && params.citedKbArticleIds.length > 0
        ? params.citedKbArticleIds
        : null,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("客服消息写入失败：未返回记录。");
  }
  return toMessageRow(row);
}

/**
 * F-2205 ("转接过程保留完整对话上下文"): the FULL transcript, oldest first.
 * `created_at` alone can tie for two rows inserted in the same real
 * request handler at sub-microsecond-indistinguishable timestamps on some
 * platforms; `id` is a stable, arbitrary-but-deterministic tiebreaker, not
 * a claim about insertion order for tied timestamps (unlike
 * `dispute_evidence_submissions`, this table has no dedicated monotonic
 * sequence column — see this migration's own doc comment for why a
 * `(conversation_id, created_at)` index is the one query pattern this
 * Task actually needs, without introducing a `BIGSERIAL` this schema
 * wasn't asked to have).
 */
export async function listMessagesByConversation(
  pool: Queryable,
  conversationId: string,
): Promise<MessageRow[]> {
  const { rows } = await pool.query<MessageDbRow>(
    `SELECT id, conversation_id, role, content, cited_kb_article_ids, created_at
     FROM customer_service_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );
  return rows.map(toMessageRow);
}

const DEFAULT_ADMIN_QUEUE_PAGE_SIZE = 50;
const MAX_ADMIN_QUEUE_PAGE_SIZE = 200;

export interface AdminQueuePage {
  conversations: ConversationRow[];
  /** Pass as `before` to fetch the next (older) page; `null` once there
   * are no further real rows past this page. */
  nextCursor: { createdAt: string; id: string } | null;
}

/**
 * F-2205's "人工客服接手队列", design.md's `GET
 * /admin/customer-service/conversations`. Decision (documented here since
 * design.md's own wording — "人工客服接手队列" — doesn't pin down whether
 * this lists ONLY escalated conversations or every conversation): defaults
 * to `escalatedOnly: true` — the literal hand-off queue is "conversations
 * that need a human," not every conversation the bot has ever had. Passing
 * `escalatedOnly: false` lists everything (useful for an operator auditing
 * bot performance, not the primary hand-off use case), most recent first
 * either way.
 *
 * N4 real finding (round 1, T-2204, P1): a flat `LIMIT 200` with no
 * pagination meant a conversation older than the 200 most-recent
 * escalations became PERMANENTLY invisible to this endpoint the moment a
 * 201st one was created — no other query parameter could ever surface it
 * again, so an operator could never see (let alone act on) an older
 * still-pending hand-off. Cursor-paginated on `(created_at, id)` DESC
 * (keyset pagination — `id` is the deterministic tiebreaker for rows
 * sharing a real timestamp, same reasoning `dispute_evidence_submissions`'s
 * own `sequence_no` tiebreaker documents) so every real row stays
 * reachable by paging, however many escalations accumulate — never an
 * OFFSET, which degrades in both correctness (rows shifting under a
 * concurrent insert) and cost as the table grows.
 */
export async function listConversationsForAdminQueue(
  pool: Queryable,
  params: { escalatedOnly: boolean; limit?: number; before?: { createdAt: string; id: string } },
): Promise<AdminQueuePage> {
  const limit = Math.min(
    Math.max(params.limit ?? DEFAULT_ADMIN_QUEUE_PAGE_SIZE, 1),
    MAX_ADMIN_QUEUE_PAGE_SIZE,
  );
  const escalatedFilter = params.escalatedOnly ? "AND escalated_to_human = true" : "";
  const cursorFilter = params.before ? "AND (created_at, id) < ($2, $3)" : "";
  const queryParams: unknown[] = [limit];
  if (params.before) {
    queryParams.push(params.before.createdAt, params.before.id);
  }

  const { rows } = await pool.query<ConversationDbRow>(
    `SELECT id, session_id, actor_address, intent, escalated_to_human, created_at
       FROM customer_service_conversations
      WHERE true ${escalatedFilter} ${cursorFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    queryParams,
  );
  const conversations = rows.map(toConversationRow);
  const lastRow = conversations[conversations.length - 1];
  const nextCursor =
    conversations.length === limit && lastRow
      ? { createdAt: lastRow.createdAt.toISOString(), id: lastRow.id }
      : null;
  return { conversations, nextCursor };
}
