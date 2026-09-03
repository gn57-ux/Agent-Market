-- Manual rollback for 0018_create_consumed_privy_tokens.sql (T-1601).
--
-- NOT wired into any automated `migrate down` command -- same forward-only
-- policy as every other rollback file in this directory. A human who has
-- confirmed this is the right action runs this file directly and then
-- manually removes the corresponding row from `schema_migrations` if the
-- migration should be considered un-applied.
--
-- DESTRUCTIVE only in the sense of losing the record of which Privy access
-- tokens have already been redeemed -- rolling this back re-opens the
-- replay window this migration exists to close (see the forward migration's
-- comment) until it is re-applied.
DROP TABLE IF EXISTS consumed_privy_tokens;

DELETE FROM schema_migrations WHERE id = '0018_create_consumed_privy_tokens.sql';
