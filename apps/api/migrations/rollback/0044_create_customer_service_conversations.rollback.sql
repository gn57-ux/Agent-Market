-- Manual rollback for 0044_create_customer_service_conversations.sql
-- (T-2204). NOT wired into any automated `migrate down` command -- same
-- forward-only policy as every other rollback file in this directory.
--
-- DESTRUCTIVE: drops every customer-service conversation and its full
-- message history. `customer_service_messages` first (matching the FK
-- direction — it references `customer_service_conversations`), even though
-- `DROP TABLE ... CASCADE` on the parent alone would also work; dropping
-- the child explicitly first is the same explicit-over-implicit convention
-- `0042_create_dispute_evidence_submissions.rollback.sql` already follows
-- for its own child-then-parent-implied table.
DROP TABLE IF EXISTS customer_service_messages;
DROP TABLE IF EXISTS customer_service_conversations;

DELETE FROM schema_migrations WHERE id = '0044_create_customer_service_conversations.sql';
