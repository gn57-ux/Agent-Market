-- Feature 6 (task-creation-funding), T-601.
-- tasks / task_skills / chain_transactions / chain_events /
-- task_state_history tables per specs/06-task-creation-funding/design.md's
-- "数据模型" section (PRD §13.2, §11.2/§11.3/§11.4).
--
-- tasks.status enumerates all 9 TaskStatus kinds from
-- packages/domain/src/task-status.ts (DRAFT | AWAITING_FUNDING | OPEN |
-- ACCEPTED | SUBMITTED | DISPUTED | RELEASED | REFUNDED | CANCELLED) so this
-- CHECK constraint is the database-layer mirror of that discriminated
-- union. Feature 7/8/9/10 write further values into this same column over
-- time but never a value outside this closed set.
--
-- No DEFAULT on tasks.status: F-601 always creates a task with status set
-- explicitly to 'DRAFT' at the application layer (see design.md's
-- POST /tasks/drafts contract). design.md doesn't declare a column default,
-- so this migration doesn't invent one — every INSERT must supply status.
--
-- Amounts (tasks.budget) are NUMERIC per Feature 5 T-505's established
-- decision (avoids the float/JS-number precision-loss path). F-609 requires
-- "最小单位无符号整数" at the application/transport layer — this migration
-- only fixes the column type and non-negativity; the integer-minimal-unit
-- encoding itself is T-602/T-604's application-layer responsibility, not a
-- database CHECK, since design.md doesn't state a decimal-scale rule to
-- enforce here.
--
-- token is the fixed YD ERC-20 token contract address (PRD §6.1: "一期只
-- 使用固定 YD Token"), populated by the application layer even though it
-- is not part of the POST /tasks/drafts request body — hence NOT NULL with
-- the same lowercase-hex address format check as other address columns.
--
-- Deliberately no IF NOT EXISTS anywhere in this file (see
-- 0001_create_users.sql's header comment for the rationale: a normal re-run
-- never reaches these statements a second time because schema_migrations
-- already skips the whole file; a same-named object existing for any other
-- reason must fail the migration loudly instead of being silently
-- accepted).
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_address TEXT NOT NULL REFERENCES users (address),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  budget NUMERIC NOT NULL,
  token TEXT NOT NULL,
  delivery_deadline TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  funding_tx_hash TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_requester_address_format CHECK (requester_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT tasks_token_format CHECK (token ~ '^0x[0-9a-f]{40}$'),
  -- `TaskEscrow.createTask` (contracts/src/TaskEscrow.sol) explicitly
  -- reverts with `ZeroBudget()` when `budget == 0` — a task persisted with
  -- budget 0 would pass every application-layer check that predates this
  -- constraint and then be permanently unfundable (AWAITING_FUNDING tasks
  -- can no longer edit their budget). schema.ts's BUDGET_SCHEMA already
  -- rejects "0" at the API boundary for a friendly 400; this CHECK is the
  -- database-layer backstop, matching this file's own established pattern
  -- of pairing app-layer validation with a DB constraint of last resort
  -- (human review, T-605 round 3 — 0005_create_tasks.sql not yet merged,
  -- so this tightens the constraint in place rather than adding a patch
  -- migration).
  CONSTRAINT tasks_budget_positive CHECK (budget > 0),
  CONSTRAINT tasks_funding_tx_hash_format CHECK (
    funding_tx_hash IS NULL OR funding_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT tasks_status_check CHECK (
    status IN (
      'DRAFT', 'AWAITING_FUNDING', 'OPEN', 'ACCEPTED', 'SUBMITTED',
      'DISPUTED', 'RELEASED', 'REFUNDED', 'CANCELLED'
    )
  ),
  -- F-601 "支持客户端幂等键"（PRD §11.3）: persisted here, not only checked
  -- in application memory, so a concurrent retry of POST /tasks/drafts with
  -- the same Idempotency-Key header can atomically resolve to the existing
  -- row via this constraint (ON CONFLICT DO NOTHING / catch-and-refetch in
  -- T-602's service layer) instead of racing to create two tasks. Scoped
  -- per requester_address, not globally unique, matching how the header is
  -- a client-chosen token (typically a UUID the client generated) rather
  -- than a server-issued value with no natural requester scope; NULL is
  -- allowed because Postgres treats NULLs as distinct for UNIQUE, and only
  -- rows created through POST /tasks/drafts carry a key at all (Codex
  -- review, T-601 round 1, P2).
  CONSTRAINT tasks_requester_idempotency_key_unique UNIQUE (requester_address, idempotency_key)
);

-- T-605's GET /tasks filtering (requester, status, category) and F-610's
-- public market query ("OPEN 及以后状态"): a composite (status, category)
-- index mirrors agents_status_category_idx's reasoning
-- (0004_create_agents.sql), plus a dedicated requester_address index for
-- "我的发布" lookups.
--
-- Deliberately no IF NOT EXISTS on any index below either — same rationale
-- as CREATE TABLE above (see 0004_create_agents.sql's index comment).
CREATE INDEX tasks_requester_address_idx ON tasks (requester_address);
CREATE INDEX tasks_status_category_idx ON tasks (status, category);

-- Multi-valued skill tags, same shape as agent_skills
-- (0004_create_agents.sql): keeps `task_skills.skill_tag = $1` filtering
-- (T-605) a plain indexed equality lookup instead of an array-containment
-- query.
CREATE TABLE task_skills (
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  skill_tag TEXT NOT NULL,
  PRIMARY KEY (task_id, skill_tag)
);

CREATE INDEX task_skills_skill_tag_idx ON task_skills (skill_tag);

-- One row per on-chain transaction relevant to a task (funding today, and
-- later acceptance/submission/etc. per design.md's
-- "purpose(FUNDING|ACCEPTANCE|...)"). The full set of purposes/statuses is
-- extended by later Features, so this migration doesn't restrict
-- `purpose`/`status` to a closed enum design.md doesn't fully enumerate —
-- unlike tasks.status, which mirrors a closed TypeScript discriminated
-- union.
--
-- UNIQUE (chain_id, tx_hash) is the database-layer enforcement of the
-- non-functional requirement "txHash 在指定链上唯一绑定一个业务动作"
-- (requirements.md) and directly backs F-605's "交易哈希未绑定其他任务"
-- check / the TRANSACTION_ALREADY_USED error code.
CREATE TABLE chain_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  CONSTRAINT chain_transactions_tx_hash_format CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_transactions_confirmations_nonnegative CHECK (confirmations >= 0),
  CONSTRAINT chain_transactions_chain_tx_hash_unique UNIQUE (chain_id, tx_hash)
);

CREATE INDEX chain_transactions_task_id_idx ON chain_transactions (task_id);

-- One row per consumed on-chain event (TaskFunded today, later event types
-- from Feature 7/8/9/10). The UNIQUE constraint on (chain_id, block_hash,
-- transaction_hash, log_index) is the exact idempotency key
-- design.md/requirements.md specify ("事件使用 (chainId, blockHash,
-- transactionHash, logIndex) 唯一标识") and is what F-606's "复核逻辑幂等，
-- 可重复执行不产生重复结果" and event-sync's reorg handling both depend on:
-- re-processing the same log a second time hits this constraint instead of
-- creating a duplicate row.
CREATE TABLE chain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  CONSTRAINT chain_events_block_hash_format CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_events_transaction_hash_format CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT chain_events_log_index_nonnegative CHECK (log_index >= 0),
  CONSTRAINT chain_events_unique_log UNIQUE (chain_id, block_hash, transaction_hash, log_index)
);

CREATE INDEX chain_events_task_id_idx ON chain_events (task_id);

-- Append-only audit trail of tasks.status transitions
-- (GET /tasks/:taskId/history, T-605). from_status is nullable — the row
-- recording a task's initial creation has no prior status to record.
CREATE TABLE task_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_state_history_from_status_check CHECK (
    from_status IS NULL OR from_status IN (
      'DRAFT', 'AWAITING_FUNDING', 'OPEN', 'ACCEPTED', 'SUBMITTED',
      'DISPUTED', 'RELEASED', 'REFUNDED', 'CANCELLED'
    )
  ),
  CONSTRAINT task_state_history_to_status_check CHECK (
    to_status IN (
      'DRAFT', 'AWAITING_FUNDING', 'OPEN', 'ACCEPTED', 'SUBMITTED',
      'DISPUTED', 'RELEASED', 'REFUNDED', 'CANCELLED'
    )
  )
);

CREATE INDEX task_state_history_task_id_idx ON task_state_history (task_id);
