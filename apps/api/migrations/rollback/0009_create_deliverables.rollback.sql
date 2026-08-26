-- Manual rollback for 0009_create_deliverables.sql (T-901).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as 0005/0006/0007/0008's rollbacks. A human who has confirmed this
-- is the right action runs this file directly and then manually removes the
-- corresponding row from `schema_migrations` if the migration should be
-- considered un-applied.
--
-- DESTRUCTIVE only in the sense of losing all recorded deliverable
-- metadata (not the underlying local files themselves, which this SQL file
-- cannot touch — a human running this rollback is responsible for deciding
-- what to do with orphaned files under the storage adapter's directory)
-- and the tasks.submitted_at/review_deadline projection; it does not touch
-- any other table.
DROP TABLE IF EXISTS deliverables;
ALTER TABLE tasks DROP COLUMN IF EXISTS submitted_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS review_deadline;

DELETE FROM schema_migrations WHERE id = '0009_create_deliverables.sql';
