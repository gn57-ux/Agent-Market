-- Feature 21 (arbitration-committee), T-2107 (F-2106, requirements.md:
-- "仲裁员与案件的需求方/Agent 存在关联关系时，人工回避（Safe 多签本身不
-- 原生支持"自动排除某个 owner 参与某次签名"，回避是流程约束，不是链上
-- 强制约束，需要在链下协调流程中明确记录）").
--
-- 方案比较（CLAUDE.md 原则 3）：
--   方案 A（选用）：独立 `arbitration_recusals` 表，一条真实记录对应一次
--   真实的"某仲裁员因利益冲突不参与某争议裁决"的声明，可按 dispute_id
--   查询同一争议的全部回避记录（3 人委员会下可能不止一人回避）。
--   方案 B（未选用）：把回避原因塞进 `disputes.reason`/一个自由文本备注
--   字段。拒绝理由：`disputes.reason` 是需求方开启争议的理由，与"某仲裁
--   员为什么回避"是完全不同的设计知识（CLAUDE.md 原则 6），混在一起会让
--   两种语义在同一字段里无法区分，也无法对"这次争议有几位仲裁员回避"这
--   类问题做真实查询。
--
-- 这张表本身就是完整的回避审计记录（F-2106 的"链下记录机制"字面要求）
-- ——不需要额外的审计表，一条真实的 INSERT 就是一次真实、不可篡改（只
-- 追加，从不 UPDATE/DELETE）的回避声明。
CREATE TABLE arbitration_recusals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes (id),
  member_address TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT arbitration_recusals_member_address_format
    CHECK (member_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT arbitration_recusals_recorded_by_format
    CHECK (recorded_by ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX arbitration_recusals_dispute_id_idx ON arbitration_recusals (dispute_id);

-- 同一争议内，同一仲裁员不应重复声明回避——真实数据里这是同一件事被误
-- 提交两次，而不是两次独立的回避决定。
CREATE UNIQUE INDEX arbitration_recusals_unique_dispute_member
  ON arbitration_recusals (dispute_id, member_address);
