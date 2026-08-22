-- Feature 5 (agent-registration), T-501.
-- agents / agent_skills tables per specs/05-agent-registration/design.md's
-- data model section (PRD §13.2). No `agent_credentials` table — stage one
-- has no real external Agent API calls to authenticate (see design.md's
-- "一期不建立凭据管理结构" decision record); `invocation_url` is a plain
-- display field, not something this contract ever calls.
--
-- `quality_score` is nullable with no explicit DEFAULT clause needed (a
-- column with no DEFAULT and no NOT NULL is NULL on insert unless a value
-- is supplied) — deliberately NOT defaulted to any numeric "neutral prior"
-- value. That prior is Feature 7's own internal runtime substitute for
-- "no real rating yet" and is never written to this table (design.md:
-- "本表不存储这个常量，也不把它当作字段默认值写进来").
--
-- Deliberately no IF NOT EXISTS (see 0001_create_users.sql's comment for
-- the rationale: an unverified pre-existing same-named table must fail the
-- migration loudly, not be silently accepted).
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_address TEXT NOT NULL REFERENCES users (address),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  author_bio TEXT,
  invocation_url TEXT,
  payout_address TEXT NOT NULL,
  pricing_model TEXT,
  reference_price NUMERIC,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  completed_task_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  overdue_count INTEGER NOT NULL DEFAULT 0,
  quality_score DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agents_owner_address_format CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT agents_payout_address_format CHECK (payout_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT agents_quality_score_range CHECK (
    quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)
  )
);

-- T-504's ownership check (only the session address matching owner_address
-- may edit/activate/deactivate) and T-503's "my agents" style queries both
-- look up by owner_address.
CREATE INDEX IF NOT EXISTS agents_owner_address_idx ON agents (owner_address);

-- T-503's GET /agents filtering (category, status) — a composite index
-- covers "active agents in category X" without a separate index per column.
CREATE INDEX IF NOT EXISTS agents_status_category_idx ON agents (status, category);

-- Multi-valued skill tags, expanded into their own table rather than an
-- array column: keeps `agent_skills.skill_tag = $1` filtering (T-503) a
-- plain indexed equality lookup instead of an array-containment query.
CREATE TABLE agent_skills (
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  skill_tag TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_tag)
);

CREATE INDEX IF NOT EXISTS agent_skills_skill_tag_idx ON agent_skills (skill_tag);
