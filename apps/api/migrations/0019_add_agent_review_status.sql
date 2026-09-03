-- Feature 16 (identity-agent-review-funds-dashboard), T-1603.
-- design.md 决策 3/5 的数据模型（specs/16-identity-agent-review-funds-dashboard/design.md）。
--
-- `review_status` 与既有 `status` 列（0004_create_agents.sql，ACTIVE/INACTIVE）
-- 是两个正交维度，不合并：`status` 是 Agent 所有者自己的开/关市场展示开关
-- （T-503 既有的 activate/deactivate 端点），`review_status` 是平台审核生命
-- 周期（DRAFT/PENDING_REVIEW/ACTIVE/REJECTED/SUSPENDED）。历史行默认
-- 'ACTIVE'：现有 Agent 在本迁移前从未经过审核流程就已在市场展示，迁移不应
-- 让它们意外消失或需要重新审核（design.md 决策 3）。
--
-- `pricing_type` 是 F-1604/F-1605 审核路由逻辑唯一读取的字段（design.md
-- 决策 5，Q-1603）——不是既有的自由文本 `pricing_model` 列（该列保留只读
-- 展示价值，两者职责分离）。历史行默认 'PER_TASK'（保守选择：不假设历史
-- Agent 是免费的，避免让本应审核的 Agent 因迁移而绕过审核；'PER_TASK' 是
-- 真实历史数据中唯一有证据支持的默认值，见 design.md 决策 5 的迁移策略
-- 说明）。
ALTER TABLE agents
  ADD COLUMN review_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (review_status IN ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED')),
  ADD COLUMN pricing_type TEXT NOT NULL DEFAULT 'PER_TASK'
    CHECK (pricing_type IN ('FREE', 'PER_TASK', 'SUBSCRIPTION', 'HOURLY'));

-- T-1605 的审核队列查询（`review_status = 'PENDING_REVIEW'`）与 T-1608b 的
-- Dashboard 积压量统计都按 review_status 过滤，量级增长后需要索引。
CREATE INDEX agents_review_status_idx ON agents (review_status);

-- Feature 16（F-1605/F-1607）审核审计——与既有 `audit_logs`（0011_create_
-- disputes.sql，任务维度）分开建表，不复用：两者是不同生命周期的审计知识，
-- 合并会让 task_id/agent_id 两个可空外键的语义变得模糊（design.md 决策 3）。
--
-- 无 IF NOT EXISTS（见 0001_create_users.sql 的说明）。
-- N4 round-1 real finding (P2): from_status/to_status must be constrained
-- to the SAME five review_status states as agents.review_status itself —
-- otherwise a typo or invalid value (e.g. 'ACTVE') writes permanently into
-- the audit trail with no way to correct it after the fact, undermining
-- the entire point of an audit log.
CREATE TABLE agent_review_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents (id),
  actor_address TEXT NOT NULL,
  from_status TEXT NOT NULL
    CHECK (from_status IN ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED')),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED')),
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_review_audit_logs_actor_address_format
    CHECK (actor_address ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX agent_review_audit_logs_agent_id_idx ON agent_review_audit_logs (agent_id);
