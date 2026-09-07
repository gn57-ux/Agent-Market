-- Feature 22 (ai-customer-service), T-2204 (F-2205: 人工客服升级, "转接过程
-- 保留完整对话上下文"). design.md's own "数据模型" section already specifies
-- this exact schema verbatim — this migration does not redesign it.
--
-- Two tables, two distinct pieces of design knowledge (CLAUDE.md 原则 6):
-- `customer_service_conversations` is "one chat session" (who it belongs to,
-- if anyone; its last-classified intent; whether it has been handed to a
-- human); `customer_service_messages` is the ordered transcript of that
-- session (T-2200/T-2201/T-2202's own `conversation-repository.ts` is the
-- ONLY module that ever reads/writes either table directly — see that
-- file's own header comment).
--
-- `actor_address` is nullable on both the conversation (present, per
-- T-2203's `generateAnswer(pool, userMessage, actorAddress: string | null)`)
-- and there is no separate `actor_address` on messages — a message's
-- authorship is fully captured by `role`, and "whose conversation this is"
-- lives once on the conversation row, not repeated per message (same
-- single-ownership reasoning `dispute_evidence_submissions` applies to
-- `dispute_id`). Address format CHECK reuses this repo's own
-- `^0x[0-9a-f]{40}$` convention (`0020_create_admin_roles.sql`,
-- `0040_create_arbitration_committee_tables.sql`), but stays nullable
-- (anonymous chat visitors are a real, first-class case here — T-2203's
-- own `actorAddress: string | null`, not an edge case to special-case
-- away).
CREATE TABLE customer_service_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  actor_address TEXT,
  intent TEXT,
  escalated_to_human BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_service_conversations_actor_address_format
    CHECK (actor_address IS NULL OR actor_address ~ '^0x[0-9a-f]{40}$')
);

-- F-2205's admin hand-off queue endpoint (`GET
-- /admin/customer-service/conversations`) filters to
-- `escalated_to_human = true` — a partial index on exactly that predicate
-- serves that query directly (same reasoning as
-- `arbitration_committee_members_status_idx`), without indexing the much
-- larger set of never-escalated rows the queue never reads.
CREATE INDEX customer_service_conversations_escalated_queue_idx
  ON customer_service_conversations (created_at)
  WHERE escalated_to_human = true;

CREATE TABLE customer_service_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES customer_service_conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'HUMAN_AGENT')),
  content TEXT NOT NULL,
  cited_kb_article_ids UUID[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The one query pattern every consumer of this table actually needs: "give
-- me this conversation's full transcript, in order" (F-2205's "转接过程保留
-- 完整对话上下文" — the admin hand-off endpoint reads every row for a
-- conversation, not a truncated tail). `(conversation_id, created_at)`
-- supports that `WHERE conversation_id = $1 ORDER BY created_at` query
-- directly, without a separate sort step.
CREATE INDEX customer_service_messages_conversation_id_created_at_idx
  ON customer_service_messages (conversation_id, created_at);
