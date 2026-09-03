-- Manual rollback for 0014_drop_expert_type_default.sql (T-1201b).
--
-- NOT wired into any automated `migrate down` command — same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- Restores the exact placeholder DEFAULT 0013 originally set — not
-- destructive to any data (a DEFAULT only affects future INSERTs that omit
-- the column; it never rewrites existing rows).
ALTER TABLE tasks
  ALTER COLUMN expert_type SET DEFAULT 'AUTOMATION';

DELETE FROM schema_migrations WHERE id = '0014_drop_expert_type_default.sql';
