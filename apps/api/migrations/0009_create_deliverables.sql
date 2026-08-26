-- Feature 9 (deliverable-submission), T-901.
-- `deliverables` table + `tasks.submitted_at`/`review_deadline` columns per
-- specs/09-deliverable-submission/design.md's "数据模型" section.
--
-- `tasks.submitted_at`/`review_deadline`: written ONLY by T-905's
-- `ResultSubmitted` event-sync handler, and written verbatim from the
-- event log's own `submittedAt`/`reviewDeadline` fields (already computed
-- by the contract in `submitResult` — see TaskEscrow.sol's `reviewWindow`
-- comment). No `+ reviewWindow` arithmetic exists anywhere in this
-- codebase outside the contract itself (design.md F-905/AC-908) — these
-- columns are a pure read-only projection, same status as
-- `tasks.accepted_at` (0006_add_dispatch_matching_fields.sql).
ALTER TABLE tasks
  ADD COLUMN submitted_at TIMESTAMPTZ NULL,
  ADD COLUMN review_deadline TIMESTAMPTZ NULL;

-- `deliverables`: one row per submission attempt (not just the latest) —
-- `GET /tasks/:taskId/deliverables/latest` (T-904) selects the most recent
-- row by `created_at`/`id`, matching `recommendation_runs`' own
-- "append-only, latest-by-recency" convention (0007_create_recommendation_tables.sql)
-- rather than an UPDATE-in-place single row, so a resubmission (e.g. after
-- the requester found an issue and the Agent submits again before
-- `submitResult` is actually called on-chain — this table only tracks the
-- link between local storage and the CURRENT session's %resultHash%,
-- `submitResult` calldata is the actual authoritative link once on-chain)
-- never loses the prior attempt's audit trail.
--
-- `storage_type`/`file_path`/`result_url` model "exactly one of file or
-- URL, never both, never neither" as a CHECK rather than two nullable
-- columns with no enforced relationship — the two mutually-exclusive
-- payload shapes design.md describes (`filePath|resultUrl`) are made
-- illegal-to-mismatch at the schema level, not just trusted to the
-- application layer.
CREATE TABLE deliverables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic tiebreaker for "which deliverable is latest" — same
  -- rationale and shape as `recommendation_runs.sequence_no`
  -- (0007_create_recommendation_tables.sql, T-706 round 1 P2): `created_at`
  -- (TIMESTAMPTZ) is not a uniqueness guarantee, and two submissions
  -- landing in the same DB-clock instant would otherwise make
  -- `ORDER BY created_at DESC LIMIT 1` pick either row nondeterministically
  -- (N4 round 1 P2, Codex, T-904). `id` (UUID v4) is not sortable-by-
  -- creation-order, so it can't serve this role either.
  sequence_no BIGSERIAL NOT NULL,
  -- ON DELETE CASCADE matches every other task_id FK in this schema
  -- (task_skills/chain_transactions/chain_events/task_state_history in
  -- 0005_create_tasks.sql, recommendation_runs in
  -- 0007_create_recommendation_tables.sql) — without it, a task that has
  -- ever received a deliverable submission could never be deleted again
  -- (N4 round 2 P2 finding, Codex).
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  agent_address TEXT NOT NULL REFERENCES users (address),
  storage_type TEXT NOT NULL CHECK (storage_type IN ('LOCAL_FILE', 'URL')),
  -- Exactly one of file_path/result_url is set, matching storage_type —
  -- `access-guard.ts`/T-907's download endpoint switches on storage_type
  -- alone and trusts this invariant rather than re-deriving it.
  file_path TEXT,
  result_url TEXT,
  CONSTRAINT deliverables_payload_matches_storage_type CHECK (
    (storage_type = 'LOCAL_FILE' AND file_path IS NOT NULL AND result_url IS NULL)
    OR (storage_type = 'URL' AND result_url IS NOT NULL AND file_path IS NULL)
  ),
  -- F-907/design.md "URL 类型成果仅允许 https 协议" — enforced here too
  -- (not only at the Zod schema boundary, T-902) so no other write path
  -- into this table can bypass the protocol restriction.
  CONSTRAINT deliverables_result_url_is_https CHECK (
    result_url IS NULL OR result_url ~ '^https://'
  ),
  mime_type TEXT,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  -- 32-byte hash, hex-encoded with 0x prefix — same shape as every other
  -- on-chain hash column in this schema (e.g. acceptance_permits' fields
  -- that carry hex-encoded chain data).
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Matches T-904's real query: latest deliverable for a task, ordered by
-- the monotonic `sequence_no` tiebreaker.
CREATE INDEX deliverables_task_id_sequence_no_idx
  ON deliverables (task_id, sequence_no DESC);
