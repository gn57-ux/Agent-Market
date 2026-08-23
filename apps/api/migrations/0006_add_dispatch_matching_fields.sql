-- Feature 7 (dispatch-matching), T-700.
-- Adds the real fields F-702's eligibility filter needs (Agent level,
-- Agent concurrent-task capacity, wallet ban list) per
-- specs/07-dispatch-matching/design.md's "数据模型" section (F-711/F-712).
-- Additive-only ALTER TABLE against the already merged
-- 0004_create_agents.sql/0005_create_tasks.sql — neither file is edited in
-- place, matching this project's convention once a migration has shipped
-- to main.
--
-- level's three-value CHECK constraint is the database-layer mirror of the
-- allowed literal set only — it does NOT express the BEGINNER < INTERMEDIATE
-- < EXPERT ordering. That ordinal comparison is a domain contract defined in
-- specs/07-dispatch-matching/design.md ("等级顺序契约") and implemented
-- exactly once, in services/dispatch/internal/domain (Go). apps/api and the
-- frontend only ever mirror this same three-literal set for validation/
-- display; they must never re-implement the ordinal comparison itself.
ALTER TABLE agents
  ADD COLUMN level TEXT NOT NULL DEFAULT 'BEGINNER'
    CHECK (level IN ('BEGINNER', 'INTERMEDIATE', 'EXPERT')),
  -- Agent-owner-configured static ceiling (F-711); no dynamic capacity/
  -- auto-scaling in this stage. The 1..100 bound is a sanity range, not a
  -- business rule this migration is defining beyond "must be positive and
  -- not absurd."
  ADD COLUMN max_concurrent_tasks INTEGER NOT NULL DEFAULT 1
    CHECK (max_concurrent_tasks BETWEEN 1 AND 100);

ALTER TABLE tasks
  -- No NULL-means-"any level" state: BEGINNER is already the lowest
  -- admission tier, so every existing/omitted task defaults to it without
  -- introducing a second "no requirement" value to reason about.
  ADD COLUMN required_agent_level TEXT NOT NULL DEFAULT 'BEGINNER'
    CHECK (required_agent_level IN ('BEGINNER', 'INTERMEDIATE', 'EXPERT')),
  -- The concurrent-capacity scope key (F-711 "并发容量作用域" decision):
  -- occupancy is counted by agent_id, never by wallet address, because one
  -- wallet can own multiple Agents and their occupancy must not blend.
  -- This is the minimal stable data boundary between this Feature (which
  -- only reads/counts) and Feature 8 (which will write it when acceptTask
  -- succeeds) — Feature 7 does not implement any acceptance state
  -- transition itself. No explicit ON DELETE clause (default RESTRICT/NO
  -- ACTION), matching this project's existing agents.owner_address/
  -- tasks.requester_address → users(address) foreign keys — CASCADE is not
  -- the default here either.
  ADD COLUMN accepted_agent_id UUID NULL REFERENCES agents (id),
  -- The on-chain accepting wallet address, kept separately from
  -- accepted_agent_id: this column exists purely for identity display and
  -- on-chain audit, and must never be used to compute concurrent-capacity
  -- occupancy for a specific Agent (two Agents can share an owner wallet).
  ADD COLUMN accepted_agent_address TEXT
    CHECK (accepted_agent_address IS NULL OR accepted_agent_address ~ '^0x[0-9a-f]{40}$'),
  -- Feature 8's design.md already plans acceptedAt; built here so Feature 8
  -- doesn't need its own migration just for this one column. Feature 7
  -- never writes to it.
  ADD COLUMN accepted_at TIMESTAMPTZ NULL;

-- No CHECK constraint tying accepted_agent_id/accepted_agent_address/status
-- together here on purpose: the atomic write happens in Feature 8's
-- acceptTask event-sync transition, and Feature 8 is the Feature that
-- should define whatever consistency constraint fits its actual final
-- model — this migration only builds the columns and their own
-- self-contained validity, not a cross-column invariant for a write path
-- that doesn't exist yet.

-- Matches the real query countActiveTasksByAgentIds (T-705) will run:
-- filter by accepted_agent_id, further filter by status. The partial index
-- (WHERE accepted_agent_id IS NOT NULL) skips every task that has never
-- been accepted, which is the overwhelming majority of rows in this table
-- at any point before Feature 8 ships.
CREATE INDEX tasks_accepted_agent_status_idx
  ON tasks (accepted_agent_id, status)
  WHERE accepted_agent_id IS NOT NULL;

-- F-712: the real data source for F-702's "钱包...未被封禁" eligibility
-- condition. Deliberately no foreign key to users(address) — a wallet can
-- be pre-emptively blocked by an operator before it ever registers on this
-- platform, so requiring an existing users row would make that impossible.
-- No admin UI/approval flow/automated risk rules/unban history in this
-- stage (F-712's stated V0 boundary) — blocking/unblocking is a direct
-- database operation an operator performs; a later Feature can add an
-- admin surface over this same table if needed. `reason` exists purely for
-- an operator's own record-keeping and must never be forwarded to the Go
-- service or exposed in any candidate/requester-facing API response
-- (apps/api's dispatch snapshot assembly only reads `address` from this
-- table to compute the batch `isBanned` set).
CREATE TABLE blocked_wallets (
  address TEXT PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  reason TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
