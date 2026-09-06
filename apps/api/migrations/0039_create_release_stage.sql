-- Feature 19 (ctr-online-learning), T-1907 (F-1910/F-1916 三阶段发布节奏，
-- 用户 2026-09-06 Q-1902 决策)。
--
-- `release_stage_state` 是"当前发布阶段"这一单一全局事实的唯一权威来源
-- （CLAUDE.md 原则 6）——`shadow-rerank.ts` 每次真实调用 Python `/rerank`
-- 时读取这里的值决定发给 Python 的 `stage` 字段，未来若要真正采纳
-- GRADUAL/PRIMARY 阶段的重排结果也必须读取这里，不得各处重复判断。单例表
-- （`id` 恒为 `true` 的 CHECK 约束，配合 PK，保证任何时刻数据库里只存在
-- 唯一一行，不需要应用层自行保证"不会插入第二行"）。默认行 `SHADOW`——与
-- design.md 决策 6/F-1916 的既定初始状态一致，且不依赖任何应用层代码就能
-- 保证一个全新环境天然从最安全的阶段起步。
CREATE TABLE release_stage_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  stage TEXT NOT NULL CHECK (stage IN ('SHADOW', 'GRADUAL', 'PRIMARY')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO release_stage_state (id, stage) VALUES (true, 'SHADOW');

-- `release_stage_audit_logs`——同 `agent_review_audit_logs`/`admin_role_
-- audit_logs`/`risk_hold_audit_logs` 既有模式（当前状态列 + 独立只追加审计
-- 表）。`gate_snapshot` 记录做出这次阶段变更判断时门槛计算的完整快照
-- （样本量/一致率/效果/稳定性四项门槛的具体数值与判定结果），使得"当时为
-- 什么允许/触发这次变更"可事后审计，不依赖调用方自行截图或记录日志。
-- `triggered_by` 区分人工批准（`human:<address>`，F-1916"任何一次推进都
-- 需要人工批准"的字面要求）与系统自动回滚（`system:auto-rollback`，用户
-- 2026-09-06 决策要求的自动回滚机制）——回滚本身不需要人工批准（这是安全
-- 方向的降级，不是推进），但仍然留痕。
CREATE TABLE release_stage_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_stage TEXT NOT NULL CHECK (from_stage IN ('SHADOW', 'GRADUAL', 'PRIMARY')),
  to_stage TEXT NOT NULL CHECK (to_stage IN ('SHADOW', 'GRADUAL', 'PRIMARY')),
  action TEXT NOT NULL CHECK (action IN ('ADVANCE', 'ROLLBACK')),
  triggered_by TEXT NOT NULL,
  reason TEXT,
  gate_snapshot JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX release_stage_audit_logs_occurred_at_idx ON release_stage_audit_logs (occurred_at);
