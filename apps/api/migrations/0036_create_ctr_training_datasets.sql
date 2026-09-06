-- Feature 19 (ctr-online-learning), T-1904.
--
-- F-1906/AC-1904 (前半): a dataset-version registry. design.md's own
-- overview line names `ctr_training_datasets` as a table this Feature adds
-- (alongside `ctr_models`), but design.md's own schema section never
-- actually wrote its CREATE TABLE — a real gap this migration fills,
-- following the same two-option comparison CLAUDE.md requires for a new
-- data model (see `dataset-builder.ts`'s own doc comment for the full
-- write-up: metadata-in-DB + rows-in-a-versioned-file, chosen over storing
-- the full feature/label matrix in Postgres itself — this table is
-- deliberately just the registry, not the data).
--
-- `data_snapshot_version` is what `ctr_models.data_snapshot_version`
-- (design.md's own schema) references by value — not a foreign key,
-- because `ctr_models` (T-1905) is free to reference a dataset version
-- built before this table existed or built by a different process; the
-- coupling is "same version string," not a DB-enforced relationship.
--
-- `mature_example_count`/`immature_exposure_count`/`censored_candidate_count`
-- are recorded at build time (not re-derivable later without re-running the
-- same query against a DB whose state has since moved on) — F-1906's own
-- explicit requirement that exposure-censoring information stay visible,
-- not silently discarded.
CREATE TABLE ctr_training_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_snapshot_version TEXT NOT NULL UNIQUE,
  feature_version TEXT NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  mature_example_count INTEGER NOT NULL,
  immature_exposure_count INTEGER NOT NULL,
  censored_candidate_count INTEGER NOT NULL,
  output_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
