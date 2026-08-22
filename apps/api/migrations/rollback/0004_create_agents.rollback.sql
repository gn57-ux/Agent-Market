-- Manual rollback for 0004_create_agents.sql (T-501).
--
-- NOT wired into any automated `migrate down` command — this project's
-- migration runner (migrate.ts) is deliberately forward-only (T-403's
-- design decision record: destructive schema changes require explicit
-- human review before running, not an automated down-migration path; see
-- .claude/rules/git-workflow.md's "数据库迁移、Schema 变更需评审，禁止未经确认
-- 的破坏性迁移"). A human who has confirmed this is the right action runs
-- this file directly (e.g. `psql $DATABASE_URL -f 0004_create_agents.rollback.sql`)
-- and then manually removes the corresponding row from `schema_migrations`
-- if the migration should be considered un-applied.
--
-- DESTRUCTIVE: drops all Agent data. Never run against a database holding
-- real Agent registrations without a separately confirmed backup/plan.
DROP TABLE IF EXISTS agent_skills CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DELETE FROM schema_migrations WHERE id = '0004_create_agents.sql';
