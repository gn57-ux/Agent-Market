-- Feature 12 (agent-task-fields-credentials), T-1200.
-- Adds the real fields F-1201/F-1202/F-1205's Agent credential/protocol
-- version and task expert-type fields need, per
-- specs/12-agent-task-fields-credentials/design.md's "数据模型" section.
-- Additive-only ALTER TABLE against the already merged
-- 0004_create_agents.sql/0005_create_tasks.sql, matching this project's
-- convention once a migration has shipped to main (see
-- 0006_add_dispatch_matching_fields.sql's own header comment for the same
-- rule).
--
-- protocol_version uses an equality CHECK (not a set) because there is
-- exactly one valid value in this stage (design.md: "一期只有一个合法值，
-- 用等值约束而非集合约束更准确表达'目前只有一个'这个事实"). credential_ref
-- is a nullable reference string (NEVER the real credential value itself —
-- see credential.ts, T-1202); NULL means "no credential configured yet", a
-- legitimate intermediate state distinct from "configured but invalid"
-- (which the CHECK constraint rejects outright).
--
-- Codex review (T-1203 round 1, P1): the original CHECK
-- (`^env://[A-Z][A-Z0-9_]*$`) let a reference name any process environment
-- variable at all (`env://DATABASE_URL`, any operator secret) — the
-- diagnostic endpoint (T-1203) would resolve and transmit whatever it
-- named. Requiring the `AGENT_` prefix (this schema's own CHECK, mirrored
-- at the API boundary by schema.ts's CREDENTIAL_REF_SCHEMA and again in
-- credential.ts's CREDENTIAL_REF_PATTERN — three independent layers, not
-- one) confines this to an operator-controlled namespace of values
-- explicitly provisioned as per-Agent credentials, matching the naming
-- convention the user specified (§8.1 answer 1: "env://AGENT_<ID>_API_KEY").
ALTER TABLE agents
  ADD COLUMN protocol_version TEXT NOT NULL DEFAULT 'v1'
    CHECK (protocol_version = 'v1'),
  -- Codex review (T-1300 round 1, P1 — surfaced against this
  -- already-shipped T-1203 code, not new to T-1300 itself): the AGENT_
  -- prefix + partial unique index (round-2 fix below, now folded into this
  -- single CHECK) still let an attacker who knows a victim Agent's public
  -- id (agentId is public — visible in any GET /agents/:agentId response
  -- and every URL that references it) PRE-CLAIM the reference string an
  -- operator would naturally use for that victim ("front-running"): set
  -- their OWN Agent's credential_ref to env://AGENT_<victim's real id>
  -- before the operator ever provisions that environment variable. Once
  -- the operator later did provision it (following the documented
  -- convention), the attacker's already-registered Agent would resolve and
  -- use the victim's real credential. A unique index alone cannot prevent
  -- this — it only stops a SECOND claim of an already-occupied string, not
  -- being first. The only way to close this without either abandoning
  -- self-service credential configuration (contradicts the user's
  -- confirmed "轮换=更新引用指向的环境变量后立即生效" self-service model) or
  -- building real secret-management infrastructure (contradicts the user's
  -- confirmed "不新增 AWS Secrets Manager/Vault 等" constraint) is to make
  -- credential_ref fully SERVER-DERIVED from the Agent's own real id rather
  -- than owner-chosen free text: this CHECK requires the value (whenever
  -- non-null) to be EXACTLY `env://AGENT_` followed by this row's own `id`
  -- with dashes stripped and hex digits uppercased. No other Agent's id
  -- can ever produce this exact string for a DIFFERENT row, so pre-claiming
  -- a specific victim's future reference is structurally impossible — the
  -- string for agent X can only ever be set on agent X's own row, enforced
  -- by Postgres itself, not by application-layer trust. See
  -- credential.ts's `computeCredentialRef` (the one function allowed to
  -- compute this value) and repository.ts's `credentialEnabled` boolean
  -- toggle that replaced the old free-text API input (owners now only ever
  -- enable/disable; they never choose or see the raw string as an input,
  -- only as a read-only computed output).
  ADD COLUMN credential_ref TEXT
    CHECK (credential_ref IS NULL OR credential_ref = 'env://AGENT_' || upper(replace(id::text, '-', '')));

-- The partial unique index from T-1203 round 2 is now REDUNDANT (the CHECK
-- above already makes credential_ref a deterministic function of `id`, so
-- two distinct rows can never compute the same non-null value) but is kept
-- anyway as a second, independent enforcement layer at effectively zero
-- cost — defense in depth, not defense in isolation.
CREATE UNIQUE INDEX agents_credential_ref_unique_idx
  ON agents (credential_ref)
  WHERE credential_ref IS NOT NULL;

-- expert_type is ultimately required at creation with no standing default
-- (F-1205: "发布任务为必填字段，无默认值——不允许'未选择'状态进入数据库"), but
-- this migration deliberately KEEPS the DEFAULT for now (user decision,
-- 2026-08-29, overriding N4 round 1's P1 in favor of round 2's P1):
-- apps/api's current `insertTaskDraft` (repository.ts) does not yet supply
-- expert_type on INSERT — T-1200 (this migration) and T-1201 (the Zod
-- schema/routes/repository work that makes expert_type genuinely required
-- end to end) are separate Tasks, and this migration alone must stay
-- compatible with the write path that exists RIGHT NOW, not the write path
-- T-1201 hasn't landed yet. Dropping the DEFAULT here would break every
-- `POST /tasks/drafts` call the moment this migration is applied to a
-- database T-1201's code hasn't reached yet (N4 round 2's real finding).
--
-- A dedicated follow-up migration drops this DEFAULT once T-1201 has
-- landed and every write path genuinely supplies the field — see
-- specs/12-agent-task-fields-credentials/tasks.md's T-1201b for that
-- migration's own Task and regression tests (before/after DROP DEFAULT,
-- plus a real task-draft-creation regression). Round 1's original concern
-- (a standing DEFAULT silently masking a future bug) is fully addressed
-- once that follow-up migration runs — it is deferred, not dropped.
ALTER TABLE tasks
  ADD COLUMN expert_type TEXT NOT NULL DEFAULT 'AUTOMATION'
    CHECK (expert_type IN (
      'DATA_ANALYSIS', 'CONTENT_GENERATION', 'SOFTWARE_DEVELOPMENT', 'RESEARCH', 'AUTOMATION'
    ));
