-- Manual rollback for 0020_create_admin_roles.sql (T-1607).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE: dropping `admin_roles` removes every current admin grant --
-- every `app.requireAdmin`-gated endpoint becomes permanently 403 for
-- everyone until the table is recreated and re-seeded (via
-- apps/api/scripts/admin-bootstrap.ts).
DROP TABLE IF EXISTS admin_role_audit_logs;
DROP TABLE IF EXISTS admin_roles;

DELETE FROM schema_migrations WHERE id = '0020_create_admin_roles.sql';
