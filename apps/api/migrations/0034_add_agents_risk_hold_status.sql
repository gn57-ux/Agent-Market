-- Feature 20 (agent-evaluation-appeal-antifraud), T-2008.
--
-- 用户 2026-09-06 Q-2003 决策："不要把反欺诈处罚伪装成 baseline_evaluation_
-- status=FAILED——'基础评测失败'和'风险处罚'是两个正交领域状态。新增独立、
-- 可审计的 risk hold/eligibility 状态"。`agents.baseline_evaluation_status`
-- (0032) 回答"这个 Agent 是否证明了自己的专业能力"；这一列回答一个完全不
-- 同的问题——"这个 Agent 当前是否因为被确认的反欺诈风险信号而被暂停撮合
-- 资格"。两者的写入方、触发条件、解除方式都不同，合并成一列会让"评测没
-- 通过"和"因为刷分被处罚"这两件事在数据里变得无法区分。
--
-- 同 `baseline_evaluation_status`/`quality_score`/`review_status` 一样的
-- "projection 列"模式（Node 的 `assembleCandidateSnapshots` 读取、Go 的
-- `eligibility.Filter` 做内存判定），但这一列没有配置开关——默认值 'NONE'
-- 对所有存量和新建 Agent 都天然安全（不会意外排除任何人），且从 'NONE' 到
-- 'HELD' 只可能经由一个真实的管理员确认操作触发，不像 `baseline_
-- evaluation_status` 那样在题库/迁移策略就绪前就已经默认对所有 Agent 为
-- "不通过"，因此可以从一开始就无条件强制生效，不需要 T-2009 那种分阶段
-- 开关。
ALTER TABLE agents
  ADD COLUMN risk_hold_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (risk_hold_status IN ('NONE', 'HELD'));

-- `risk_hold_audit_logs`: 用户 2026-09-06 Q-2003 决策的"保留审计记录"要求
-- ——同 `agent_review_audit_logs`/`admin_role_audit_logs` 既有模式（当前状
-- 态列 + 独立的、只追加的审计日志表），不是把审计信息塞进 `risk_signals`
-- 本身（那张表属于检测模块，见 F-2010 的边界；HOLD/RELEASE 是这张表的
-- 独立处罚模块自己的知识，不应该反向要求检测模块的表结构为它让路）。
-- `risk_signal_id` 可空——RELEASE 动作是"解除当前 HOLD"，不一定对应某一
-- 个特定信号（可能是多个信号共同导致的 HOLD）。
CREATE TABLE risk_hold_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents (id),
  risk_signal_id UUID REFERENCES risk_signals (id),
  action TEXT NOT NULL CHECK (action IN ('HOLD', 'RELEASE')),
  actor_address TEXT NOT NULL,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risk_hold_audit_logs_actor_address_format
    CHECK (actor_address ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX risk_hold_audit_logs_agent_id_idx ON risk_hold_audit_logs (agent_id);
