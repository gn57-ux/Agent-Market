-- Manual rollback for 0033_add_risk_signals_one_open_per_subject.sql
-- (T-2005). NOT wired into any automated `migrate down` command -- same
-- forward-only policy as every other rollback file in this directory.
DROP INDEX IF EXISTS risk_signals_one_open_per_agent_and_type;

DELETE FROM schema_migrations WHERE id = '0033_add_risk_signals_one_open_per_subject.sql';
