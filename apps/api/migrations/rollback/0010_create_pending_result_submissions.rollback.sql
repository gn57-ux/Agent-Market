-- Manual rollback for 0010_create_pending_result_submissions.sql (T-905).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly.
--
-- DESTRUCTIVE only in the sense of losing any in-flight (not-yet-final)
-- pending submission rows; it does not touch `tasks`, `chain_events`, or
-- `chain_transactions` — this table was never load-bearing for any of them
-- (a pending row's existence never implied any change to `tasks`).
DROP TABLE IF EXISTS pending_result_submissions;

DELETE FROM schema_migrations WHERE id = '0010_create_pending_result_submissions.sql';
