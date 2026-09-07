-- Feature 21 (arbitration-committee), T-2108 (F-2110: "更细粒度的争议
-- 证据——支持多方多轮举证，而不只是单次文本摘要（链下结构化记录，属于
-- F-2114 审计记录的一部分）").
--
-- `disputes.evidence_summary`（Feature 10）保持不变，仍是需求方发起争议
-- 时的原始理由摘要——这张新表不替换它，而是承接"发起之后"的后续多轮
-- 举证，任一方（需求方/Agent）均可提交，可提交任意多轮。方案比较
-- （CLAUDE.md 原则 3）：
--   方案 A（选用）：独立 `dispute_evidence_submissions` 表，一条真实记录
--   对应一次真实的举证提交，天然支持"多轮"（同一 dispute_id 多行）与
--   "多方"（`submitter_role` 区分），按时间排序即完整举证时间线。
--   方案 B（未选用）：把新增举证追加到 `disputes.evidence_summary` 单个
--   TEXT 字段（拼接文本）。拒绝理由：无法区分"谁在什么时间提交了什么"，
--   也无法做真实的按提交者/按轮次查询——把结构化的多方多轮数据硬塞进一
--   个非结构化字段，是本项目 CLAUDE.md 原则 8"让非法状态无法表示"明确
--   反对的做法。
-- N4 real finding (P2, round 1, T-2108): `disputes.task_id` already
-- cascades on task deletion (`0011_create_disputes.sql`); a plain
-- (non-cascading) FK here would make that existing task-deletion path
-- start failing the moment a disputed task ever accumulates evidence
-- submissions — `ON DELETE CASCADE` preserves the established behavior
-- rather than silently regressing it.
--
-- `sequence_no` (N4 real finding, P2, round 1): `submitted_at` alone
-- cannot give a genuinely deterministic ordering for two submissions
-- landing in the same real millisecond — a `BIGSERIAL` is Postgres's own
-- strictly monotonic per-table counter, assigned atomically at INSERT
-- time, so ordering by it (not by the wall-clock timestamp) reflects the
-- real, unambiguous insertion order even under real concurrent writes.
CREATE TABLE dispute_evidence_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_no BIGSERIAL NOT NULL,
  dispute_id UUID NOT NULL REFERENCES disputes (id) ON DELETE CASCADE,
  submitter_address TEXT NOT NULL,
  submitter_role TEXT NOT NULL CHECK (submitter_role IN ('REQUESTER', 'AGENT')),
  content TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- N4 real finding (P2, round 2, T-2108): F-2110 allows unlimited rounds
-- from either real party — an unpaginated `GET` reading every row for a
-- dispute is a real resource-exhaustion path a participant could trigger
-- just by submitting enough real rounds. `(dispute_id, sequence_no)`
-- supports the cursor-paginated query (`WHERE dispute_id = $1 AND
-- sequence_no > $2 ORDER BY sequence_no LIMIT $3`) without a separate
-- sort step — replaces the plain single-column index, which would still
-- need an extra sort for the same query.
CREATE INDEX dispute_evidence_submissions_dispute_id_sequence_no_idx
  ON dispute_evidence_submissions (dispute_id, sequence_no);
