-- Manual rollback for 0031_create_evaluation_tables.sql (T-2000). NOT wired
-- into any automated `migrate down` command -- same forward-only policy as
-- every other rollback file in this directory.
--
-- DESTRUCTIVE: drops all six evaluation/antifraud tables and every row
-- they hold (rubrics, tasks, submissions, results, appeals, risk signals).
DROP TABLE IF EXISTS risk_signals;
DROP TABLE IF EXISTS evaluation_appeals;
DROP TABLE IF EXISTS evaluation_results;
DROP TABLE IF EXISTS evaluation_submissions;
DROP TABLE IF EXISTS evaluation_tasks;
DROP TABLE IF EXISTS evaluation_rubrics;

DELETE FROM schema_migrations WHERE id = '0031_create_evaluation_tables.sql';
