-- Feature 10 (review-timeout-dispute), T-1002.
--
-- `disputes`: one row per `POST /tasks/:taskId/disputes` submission
-- (F-1003). `evidence_summary` is the full-text evidence, kept off-chain
-- (design.md's "证据正文链下、摘要哈希链上"); `evidence_hash` is the
-- SHA-256 digest this backend computes over it — the SAME value the
-- requester's `openDispute(taskId, evidenceHash)` call must submit
-- on-chain, so the on-chain event and this row can later be cross-checked
-- (mirroring 0009_create_deliverables.sql's `deliverables.result_hash`
-- convention: a 32-byte hex hash, hex-encoded with `0x` prefix).
--
-- One `OPEN` dispute per task at a time is this table's own invariant —
-- enforced by `disputes_task_id_unique_open` (a partial unique index on
-- `task_id` WHERE `status = 'OPEN'`), not a plain `UNIQUE (task_id)`:
-- `TaskEscrow.openDispute` itself only allows a `SUBMITTED` task to become
-- `DISPUTED` once, so at most one dispute can ever be actively open for a
-- given task, but a HISTORICAL resolved dispute row must never block
-- creating this migration's own audit trail from being read later (there
-- is deliberately no scenario where a second dispute reopens for the same
-- task in this Feature's one-shot arbitration model, but the partial
-- index only enforces the invariant that actually matters: never two
-- simultaneously-OPEN disputes for one task).
--
-- `resolution`/`resolved_by`/`resolved_at` stay NULL until
-- `DisputeResolved` is synced (T-1002's own event-sync half) — mirrors
-- `deliverables.file_path`/`result_url`'s "populated later, not at
-- INSERT time" shape.
CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  requester_address TEXT NOT NULL REFERENCES users (address),
  reason TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('SUPPORT_AGENT', 'SUPPORT_REQUESTER')),
  resolved_by TEXT REFERENCES users (address),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT disputes_resolution_matches_status CHECK (
    (status = 'OPEN' AND resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX disputes_task_id_unique_open
  ON disputes (task_id) WHERE status = 'OPEN';

CREATE INDEX disputes_task_id_idx ON disputes (task_id);

-- `audit_logs`: PRD §15.1's "仲裁及管理操作记录操作者、时间、原因、交易哈希"
-- requirement — this Feature's own scope is arbitration
-- (`resolveDispute`) specifically, so `action`/`reason`/`tx_hash` are
-- populated by `verifyDisputeResolution` (tasks/service.ts) alongside its
-- own `chain_transactions`/`chain_events`/`disputes` writes, all in the
-- same transaction. A free TEXT `action` column (not a closed enum),
-- matching `chain_transactions.purpose`'s own established "not a DB-level
-- enum" convention (0005_create_tasks.sql) — this table's own future
-- consumers (e.g. a later Feature logging a different admin action) are
-- not this migration's concern to predict.
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_address TEXT NOT NULL,
  action TEXT NOT NULL,
  task_id UUID REFERENCES tasks (id) ON DELETE CASCADE,
  reason TEXT,
  tx_hash TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_task_id_idx ON audit_logs (task_id);
