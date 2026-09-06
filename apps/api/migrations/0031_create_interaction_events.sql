-- Feature 19 (ctr-online-learning), T-1900.
--
-- F-1901/F-1902 "真实事件采集" + "事件 ID 与去重". design.md 决策 1 的既定
-- 结论（方案 B）：`interaction_events` 是本 Feature 真正新增的核心表，与
-- `recommendation_candidates`（Feature 7/13 既有表）各自独立——后者保持
-- 不变，只作为"这次曝光包含哪些候选"的关联数据源（本表的 `EXPOSURE` 事件
-- 通过 `run_id` 关联回 `recommendation_runs`，不复制其数据）。
--
-- `event_type` 是 requirements.md F-1901 逐字列出的 9 类真实事件，本表
-- 用 CHECK 约束闭合枚举（不像 `outbox_events.event_type`/
-- `chain_indexed_events.event_type` 那样留作自由 TEXT）——那两处枚举会随
-- 未来新消费者持续增长，而这 9 类事件是本 Feature requirements.md 明确
-- 定稿的采集范围（F-1901 原文），新增事件类型本身就是需要重新走规格评审
-- 的范围变更，不是运行期自然增长的自由值。
--
-- `client_event_id` 是 F-1902 去重的唯一依据——前端生成，同一次真实用户
-- 行为的重复上报（网络重试等）复用同一个 ID，`UNIQUE` 约束是数据库层面
-- 保证"重复上报不产生重复事件记录"（AC-1902）的最终防线；写入方（T-1901
-- 的采集端点）用 `ON CONFLICT (client_event_id) DO NOTHING` 让重复上报
-- 变成安全的无操作，而不是让调用方每次先查询是否已存在。
--
-- `task_id`/`agent_id`/`run_id` 均可为空——不是每种事件都天然关联全部
-- 三者（例如登录/浏览类事件可能没有 `task_id`；`RATE`/`REFUND`/`DISPUTE`
-- 等事件不一定关联某次具体的撮合 `run_id`），本表不强制一种事件形状去
-- 拟合所有 9 种真实语义不同的事件。
--
-- Deliberately no `IF NOT EXISTS`（同 0001_create_users.sql 已确立的
-- 惯例理由）。
CREATE TABLE interaction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('EXPOSURE', 'VIEW', 'CLICK', 'ACCEPT', 'SUBMIT', 'APPROVE', 'RATE', 'REFUND', 'DISPUTE')),
  session_id TEXT NOT NULL,
  actor_address TEXT,
  task_id UUID REFERENCES tasks (id),
  agent_id UUID REFERENCES agents (id),
  run_id UUID REFERENCES recommendation_runs (id),
  client_event_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_event_id)
);

-- T-1901 的采集端点会按 `session_id` 做会话内事件关联（F-1904）、按
-- `task_id` 做单个任务的全链路事件回放（AC-1901 的验证方式），两者都是
-- 已知的、Task 层面已写明的真实未来查询模式，现在建索引而不是等真实慢
-- 查询出现后再补（同 `chain_indexed_events_block_number_idx` 已确立的
-- "有明确已知消费者的预建索引"惯例，不是无依据的预先优化）。
CREATE INDEX interaction_events_session_idx ON interaction_events (session_id);
CREATE INDEX interaction_events_task_idx ON interaction_events (task_id);
