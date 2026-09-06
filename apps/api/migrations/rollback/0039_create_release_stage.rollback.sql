-- Manual rollback for 0039_create_release_stage.sql (T-1907). NOT wired
-- into any automated `migrate down` command -- same forward-only policy as
-- every other rollback file in this directory.
--
-- DESTRUCTIVE: drops the current release stage and its entire audit
-- history.
DROP TABLE IF EXISTS release_stage_audit_logs;
DROP TABLE IF EXISTS release_stage_state;

DELETE FROM schema_migrations WHERE id = '0039_create_release_stage.sql';
