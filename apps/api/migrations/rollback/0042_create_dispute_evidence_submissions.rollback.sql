-- Manual rollback for 0042_create_dispute_evidence_submissions.sql
-- (T-2108). NOT wired into any automated `migrate down` command -- same
-- forward-only policy as every other rollback file in this directory.
--
-- DESTRUCTIVE: drops the entire multi-round evidence history.
DROP TABLE IF EXISTS dispute_evidence_submissions;

DELETE FROM schema_migrations WHERE id = '0042_create_dispute_evidence_submissions.sql';
