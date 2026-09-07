-- Feature 21 (arbitration-committee), T-2102 (F-2104/F-2114,
-- requirements.md v1.2/design.md v1.1)。
--
-- 三张表分别对应"名册"/"升级记录"/"决定+执行记录"三个不同的设计知识
-- 归属（CLAUDE.md 原则 6）：`arbitration_committee_members` 是"当前谁是
-- 仲裁委员会成员"这一链下名册（必须与链上 Safe 实际 owner 集合保持一致，
-- design.md"安全与兼容性"——两者不同步本身是需要告警的异常状态，但一致性
-- 校验属于应用层职责，不是这张表自己的约束）；`arbitration_upgrade_log`
-- 是"`ARBITRATOR_ROLE` 何时从哪个地址轮换到哪个地址"这一独立事件流
-- （正向轮换与 T-2109 的回滚演练共用同一张表——回滚本身就是一次对称的
-- 反向轮换，不是需要单独建模的另一种事件）；`arbitration_decisions` 是
-- 每一次真实 Safe 多签裁决的决定+执行记录，`dispute_id` 外键关联到
-- Feature 10 已有的 `disputes` 表，不重复存储争议本身的字段。
--
-- 地址列格式一律沿用 `0020_create_admin_roles.sql` 已建立的
-- `^0x[0-9a-f]{40}$` CHECK 约定（小写十六进制 40 位）。

CREATE TABLE arbitration_committee_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by TEXT,
  removed_at TIMESTAMPTZ,
  CONSTRAINT arbitration_committee_members_member_address_format
    CHECK (member_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT arbitration_committee_members_added_by_format
    CHECK (added_by ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT arbitration_committee_members_removed_by_format
    CHECK (removed_by IS NULL OR removed_by ~ '^0x[0-9a-f]{40}$'),
  -- F-2104：一次成员变更要么是"新增"（removed_by/removed_at 均为空，
  -- status=ACTIVE）要么是"移除"（两者均非空，status=REMOVED）——不存在
  -- 半完成的中间态，同 `disputes_resolution_matches_status` 的既有配对
  -- 约束模式。
  CONSTRAINT arbitration_committee_members_removed_fields_match_status CHECK (
    (status = 'ACTIVE' AND removed_by IS NULL AND removed_at IS NULL)
    OR (status = 'REMOVED' AND removed_by IS NOT NULL AND removed_at IS NOT NULL)
  )
);

CREATE INDEX arbitration_committee_members_status_idx
  ON arbitration_committee_members (status);

-- 同一时刻同一地址至多只能有一条 ACTIVE 记录——防止同一成员被重复添加
-- 后产生两条独立的"当前有效"名册行。
CREATE UNIQUE INDEX arbitration_committee_members_unique_active_address
  ON arbitration_committee_members (member_address) WHERE status = 'ACTIVE';

CREATE TABLE arbitration_upgrade_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_address TEXT NOT NULL,
  from_arbitrator_address TEXT NOT NULL,
  to_arbitrator_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT arbitration_upgrade_log_actor_address_format
    CHECK (actor_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT arbitration_upgrade_log_from_address_format
    CHECK (from_arbitrator_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT arbitration_upgrade_log_to_address_format
    CHECK (to_arbitrator_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT arbitration_upgrade_log_tx_hash_format
    CHECK (tx_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX arbitration_upgrade_log_occurred_at_idx
  ON arbitration_upgrade_log (occurred_at);

-- N4 real finding (P1, round 1, T-2102): `array_length(signer_addresses, 1)
-- >= 2` alone does not prove a real 2-of-3 Safe execution — an EMPTY array
-- makes `array_length` return `NULL` (not `0`), and `NULL >= 2` is `NULL`,
-- which a CHECK constraint silently treats as satisfied (Postgres only
-- rejects a CHECK that evaluates to `false`, never one that evaluates to
-- `NULL`); the same bare cardinality check also accepts a repeated address
-- (`[MEMBER_A, MEMBER_A]`) or two syntactically-invalid strings. A CHECK
-- constraint itself cannot contain a subquery, so the real "at least two
-- DISTINCT, address-shaped signers" invariant is expressed as a small
-- `IMMUTABLE` SQL function instead (the standard, well-established way to
-- validate array contents beyond what an inline CHECK expression can do).
-- `OR REPLACE` (not a plain `CREATE FUNCTION`): a function, unlike a
-- table, is not dropped by another migration's `DROP TABLE ... CASCADE`
-- even when it backs that table's own CHECK constraint — this is defensive
-- against the function outliving a table drop in a shared/reused
-- database (this repo's own integration-test convention across
-- migration files: this file's own `arbitration-committee-migration
-- .integration.test.ts` drops-and-reapplies this exact migration within
-- a single shared test database), not something normal production
-- `schema_migrations`-tracked application ever exercises twice.
CREATE OR REPLACE FUNCTION arbitration_decisions_has_distinct_valid_signers(addresses TEXT[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- N4 real finding (P1, round 2): `addr !~ regex` on a `NULL` array
  -- element evaluates to `NULL`, not `true` — `NOT EXISTS (... WHERE
  -- addr !~ regex)` therefore never "finds" a NULL element as invalid,
  -- letting `[<a real address>, NULL]` slip through as if it were two
  -- real, distinct signers. `addr IS NULL OR addr !~ regex` makes a NULL
  -- element explicitly invalid on its own, independent of the regex
  -- comparison's own three-valued-logic behavior.
  SELECT
    cardinality(addresses) >= 2
    AND NOT EXISTS (
      SELECT 1 FROM unnest(addresses) AS addr
      WHERE addr IS NULL OR addr !~ '^0x[0-9a-f]{40}$'
    )
    AND cardinality(addresses) = cardinality(ARRAY(SELECT DISTINCT unnest(addresses)))
$$;

CREATE TABLE arbitration_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes (id),
  safe_tx_hash TEXT NOT NULL,
  onchain_tx_hash TEXT NOT NULL,
  supported_party TEXT NOT NULL CHECK (supported_party IN ('AGENT', 'REQUESTER')),
  signer_addresses TEXT[] NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT arbitration_decisions_safe_tx_hash_format
    CHECK (safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT arbitration_decisions_onchain_tx_hash_format
    CHECK (onchain_tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- F-2107：Safe 2/3 阈值下真实执行的一次裁决至少有 2 个不同、地址格式合法
  -- 的签名者——空数组、单签名、重复地址或非法字符串均不可能是一次真实
  -- 达到阈值的 Safe 多签执行结果。
  CONSTRAINT arbitration_decisions_at_least_two_distinct_valid_signers
    CHECK (arbitration_decisions_has_distinct_valid_signers(signer_addresses))
);

CREATE INDEX arbitration_decisions_dispute_id_idx
  ON arbitration_decisions (dispute_id);
