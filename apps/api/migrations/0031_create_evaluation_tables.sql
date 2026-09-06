-- Feature 20 (agent-evaluation-appeal-antifraud), T-2000.
--
-- Six tables, verbatim from design.md's own schema section. F-2011's own
-- hard boundary: none of these six tables reference or duplicate any
-- Feature 13 reputation-signal column/table (`recommendation_candidates
-- .reputation_signals`, `agents.completed_task_count`, `ratings`,
-- `disputes`, `task_state_history`) — verified by inspection during design,
-- re-verified here by construction: every FK below points only at
-- `agents` (identity) or at this Feature's own new tables, never at any
-- Feature 13 table. Evaluation is a professional-competence assessment
-- (independent, designed test tasks), structurally disjoint from
-- reputation (statistics derived from real completed marketplace tasks).
--
-- `evaluation_rubrics`: a versioned scoring-dimension definition.
-- `rubric_version` is the real identity a historical `evaluation_results`
-- row's `rationale` is interpreted against — revising a rubric creates a
-- NEW version row, it never mutates an existing one (F-2001's own "修订
-- 不影响已完成评测的历史记录解释" requirement), so there is no UPDATE path
-- for `criteria` by design.
CREATE TABLE evaluation_rubrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_version TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  criteria JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `evaluation_tasks`: a concrete test scenario an Agent completes to be
-- scored against its rubric — distinct from the marketplace's own `tasks`
-- table (real requester-posted work), per F-2002's own "区别于市场上真实
-- 需求方发布的任务" framing. `scoring_mode` is the one field design.md's
-- own 决策 2 hangs the whole AI/human-review boundary on: `RULE_BASED`
-- tasks are scored deterministically and need no mandatory human review;
-- `HUMAN_REQUIRED` tasks (open-ended, not rule-scorable) always need one.
CREATE TABLE evaluation_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id UUID NOT NULL REFERENCES evaluation_rubrics (id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  scoring_mode TEXT NOT NULL CHECK (scoring_mode IN ('RULE_BASED', 'HUMAN_REQUIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `evaluation_submissions`: one Agent's real attempt at one evaluation
-- task. `submitted_content` holds a REFERENCE (e.g. a Feature 9-style
-- local file path, or a short inline answer for text-only tasks), never
-- large binary content inline — this Task only creates the column; T-2001
-- (the real submission endpoint) owns the actual storage-shape decision.
CREATE TABLE evaluation_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_task_id UUID NOT NULL REFERENCES evaluation_tasks (id),
  agent_id UUID NOT NULL REFERENCES agents (id),
  submitted_content TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `evaluation_results`: one scoring event for one submission.
-- `scored_by` is F-2005's own "AI/人工评分标注可区分" requirement made
-- structural — a closed three-value enum, not a free-text label a caller
-- could get wrong. `reviewer_address` MUST be set for `HUMAN` and MUST be
-- NULL for `RULE`/`AI` — a symmetric two-way CHECK (N4 real finding, P2,
-- round 2: round 1's fix only enforced the HUMAN half, leaving `RULE`/`AI`
-- rows free to carry a `reviewer_address` and misrepresent an automated
-- score as human-reviewed — the exact confusion F-2005 exists to prevent).
-- `UNIQUE (id, submission_id)` exists purely so `evaluation_appeals` below
-- can enforce "the resulting result belongs to the SAME submission as the
-- appealed result" via a composite foreign key — this codebase has no
-- triggers anywhere (verified by inspection), so a same-parent invariant
-- across two rows in the same table is expressed this way, not via a
-- trigger function.
CREATE TABLE evaluation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES evaluation_submissions (id),
  scored_by TEXT NOT NULL CHECK (scored_by IN ('RULE', 'AI', 'HUMAN')),
  reviewer_address TEXT,
  score NUMERIC NOT NULL,
  rationale TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_results_reviewer_matches_scored_by CHECK (
    (scored_by = 'HUMAN' AND reviewer_address IS NOT NULL)
    OR (scored_by <> 'HUMAN' AND reviewer_address IS NULL)
  ),
  CONSTRAINT evaluation_results_submission_id_id_unique UNIQUE (submission_id, id)
);

-- `evaluation_appeals`: F-2004's own appeal record. `status` starts
-- `PENDING` and moves to `RE_REVIEWED` exactly once a re-review actually
-- produces a new `evaluation_results` row (T-2004). N4 real finding (P1,
-- round 1): the original version tried to identify that resulting row by
-- joining back through `submission_id` alone — once a submission has more
-- than one scoring event (which this schema always allows: nothing stops
-- a submission from being rescored), that join is ambiguous and can return
-- the wrong result or several. `resulting_evaluation_result_id` is the
-- explicit, unambiguous link AC-2002's "复评结果与初评、申诉理由三者都可
-- 查询" actually requires — `NULL` while `PENDING`, set exactly once when
-- the appeal transitions to `RE_REVIEWED` (T-2004 owns writing both
-- together in one transaction), enforced as a pair by the CHECK below so
-- the two columns can never drift apart.
--
-- N4 real finding (P1, round 2): round 1's plain FK on
-- `resulting_evaluation_result_id` only proved it names SOME real result —
-- nothing stopped it from being the SAME row as `evaluation_result_id`
-- (not a re-review at all), or a result belonging to an entirely different
-- submission/agent. `submission_id` is denormalized here (derivable from
-- `evaluation_result_id`, but the only way to let the database itself
-- verify the SAME-submission invariant without a trigger) and two
-- composite FKs pin both `evaluation_result_id` and
-- `resulting_evaluation_result_id` to a result belonging to THIS
-- `submission_id` (MATCH SIMPLE's default null-tolerant semantics mean the
-- second FK is trivially satisfied while `resulting_evaluation_result_id`
-- is still NULL, i.e. while `PENDING`) — the writing repository function
-- (T-2004) is responsible for populating `submission_id` from the
-- appealed result's own `submission_id`, and the "same submission" claim
-- is checked by Postgres, not trusted to that code being correct.
--
-- N4 real finding (P2, T-2004): nothing above stops the SAME
-- `evaluation_result_id` from having several independently-resolvable
-- `PENDING` appeals at once — an owner retrying the appeal endpoint (or two
-- browser tabs) could create two, and an admin resolving each separately
-- would leave TWO conflicting `RE_REVIEWED` outcomes for one original
-- score. `evaluation_appeals_one_pending_per_result` (below, a partial
-- unique index scoped to `status = 'PENDING'`, same pattern as
-- `disputes_task_id_unique_open` in 0011_create_disputes.sql) makes "at
-- most one open appeal per result" a real database guarantee; once that
-- appeal resolves to `RE_REVIEWED` the index no longer applies, so a
-- SECOND appeal against the same original result (after the first is
-- resolved) is legitimately allowed if the owner still disagrees.
CREATE TABLE evaluation_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL,
  evaluation_result_id UUID NOT NULL,
  agent_owner_address TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RE_REVIEWED')),
  resulting_evaluation_result_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_appeals_result_matches_status CHECK (
    (status = 'PENDING' AND resulting_evaluation_result_id IS NULL)
    OR (status = 'RE_REVIEWED' AND resulting_evaluation_result_id IS NOT NULL)
  ),
  CONSTRAINT evaluation_appeals_resulting_result_is_different CHECK (
    resulting_evaluation_result_id IS NULL
    OR resulting_evaluation_result_id <> evaluation_result_id
  ),
  CONSTRAINT evaluation_appeals_evaluation_result_same_submission
    FOREIGN KEY (submission_id, evaluation_result_id)
    REFERENCES evaluation_results (submission_id, id),
  CONSTRAINT evaluation_appeals_resulting_result_same_submission
    FOREIGN KEY (submission_id, resulting_evaluation_result_id)
    REFERENCES evaluation_results (submission_id, id)
);

-- `risk_signals`: design.md 决策 1's own hard governance boundary made a
-- table — antifraud detection (T-2005/2006/2007) may ONLY INSERT here,
-- never write to `agents`/`ratings`/any chain-transaction table directly.
-- `subject_agent_id` is nullable (a signal like COLLUSION may implicate a
-- pattern across accounts with no single clean "subject", captured instead
-- via `evidence`); `subject_address` likewise nullable and independent —
-- a signal can name an agent, a wallet address, or both, never neither,
-- enforced here as a CHECK (N4 real finding, P2, round 1: originally left
-- to the writing repository function, the same factually-incorrect
-- precedent claim as `evaluation_results.reviewer_address` above — fixed
-- the same way).
-- `status` starts `DETECTED`; only a real admin action (T-2008, reusing
-- Feature 16's `app.requireAdmin`) can move it to `CONFIRMED`/`DISMISSED`
-- — `CONFIRMED` is what actually authorizes any downstream real
-- consequence, never the detection itself (F-2010).
CREATE TABLE risk_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type TEXT NOT NULL CHECK (
    signal_type IN ('SCORE_MANIPULATION', 'FAKE_DELIVERY', 'COLLUSION', 'DUPLICATE_ACCOUNT')
  ),
  subject_agent_id UUID REFERENCES agents (id),
  subject_address TEXT,
  evidence JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'DETECTED' CHECK (
    status IN ('DETECTED', 'UNDER_REVIEW', 'CONFIRMED', 'DISMISSED')
  ),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT risk_signals_has_subject CHECK (
    subject_agent_id IS NOT NULL OR subject_address IS NOT NULL
  )
);

-- Known future query patterns already named in tasks.md/design.md (T-2001
-- fetches an Agent's own submissions/results; T-2008 lists pending risk
-- signals) — pre-built the same way this codebase's other migrations
-- already establish indexes for a Task's own stated consumer, not as
-- speculative optimization.
CREATE INDEX evaluation_submissions_agent_id_idx ON evaluation_submissions (agent_id);
CREATE INDEX evaluation_results_submission_id_idx ON evaluation_results (submission_id);
CREATE INDEX evaluation_appeals_evaluation_result_id_idx
  ON evaluation_appeals (submission_id, evaluation_result_id);
CREATE UNIQUE INDEX evaluation_appeals_one_pending_per_result
  ON evaluation_appeals (evaluation_result_id) WHERE status = 'PENDING';
CREATE INDEX risk_signals_status_idx ON risk_signals (status, detected_at);
CREATE INDEX risk_signals_subject_agent_id_idx ON risk_signals (subject_agent_id);
