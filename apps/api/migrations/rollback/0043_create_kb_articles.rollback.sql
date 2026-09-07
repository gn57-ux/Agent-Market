-- Manual rollback for 0043_create_kb_articles.sql (T-2200). NOT wired into
-- any automated `migrate down` command -- same forward-only policy as
-- every other rollback file in this directory.
--
-- DESTRUCTIVE: drops the entire knowledge base content.
DROP TABLE IF EXISTS kb_articles;

DELETE FROM schema_migrations WHERE id = '0043_create_kb_articles.sql';
