-- Feature 16 (identity-agent-review-funds-dashboard), T-1607.
-- design.md 决策/接口契约（specs/16-identity-agent-review-funds-dashboard/
-- design.md）："管理员端点统一挂一个 app.requireAdmin 中间件...复用 app.
-- requireSession 的模式，在其基础上叠加 isAdminAddress 检查"。
--
-- `admin_roles` 是这一权限判定的唯一真相来源：`app.requireAdmin` 每次请求
-- 都对本表做运行时查表校验，不信任前端声明、不读取环境变量做运行时判断
-- （首个管理员的引导方式是独立的离线 CLI 脚本，见
-- apps/api/scripts/admin-bootstrap.ts，只在迁移后表为空这一次性场景下直接
-- 写入本表，不经过任何 HTTP 端点——CLI 脚本本身不属于这条运行时权限判定
-- 路径，只是其一次性的初始数据来源）。
--
-- `address` 直接作为主键（而非独立的 `id UUID` + `UNIQUE(address)`）：一个
-- 地址要么是管理员要么不是，没有需要区分的"同一地址多条授予记录"场景，
-- `granted_at`/`granted_by` 只需要反映"当前这次授予"，历史授予/撤销留痕
-- 交给 T-1607 要求的 `agent_review_audit_logs`（或独立审计表，视实现时是否
-- 语义重合而定）记录，不在本表内维护多版本历史。
CREATE TABLE admin_roles (
  address TEXT PRIMARY KEY,
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_roles_address_format CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT admin_roles_granted_by_format CHECK (granted_by ~ '^0x[0-9a-f]{40}$')
);

-- 授予/撤销的审计留痕。不复用 0019 的 `agent_review_audit_logs`——那张表的
-- `agent_id UUID NOT NULL REFERENCES agents (id)` 是 Agent 审核生命周期特有
-- 的外键，管理员角色变更没有对应的 Agent，语义不重合（design.md 决策 3 的
-- "设计知识单一归属"原则：两种不同生命周期的审计不共用一张表，避免字段
-- 变得模糊）。
CREATE TABLE admin_role_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_address TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('GRANT', 'REVOKE')),
  actor_address TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_role_audit_logs_target_address_format
    CHECK (target_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT admin_role_audit_logs_actor_address_format
    CHECK (actor_address ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX admin_role_audit_logs_target_address_idx ON admin_role_audit_logs (target_address);
