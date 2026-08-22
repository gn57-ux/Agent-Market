-- Feature 4 (wallet-identity), T-403.
-- users table per specs/04-wallet-identity/design.md data model section.
--
-- Ethereum addresses are normalized to lowercase by the application layer
-- (see apps/api/src/modules/auth/nonce.store.ts normalizeAddress) before any
-- read or write, so two differently-cased strings for the same wallet never
-- produce two rows here. The CHECK constraint enforces that invariant at the
-- data layer as a second line of defense against a caller that forgets to
-- normalize.
--
-- Deliberately no IF NOT EXISTS here (Codex review, T-403 round 2, P2): the
-- migration runner's own `schema_migrations` bookkeeping is what makes a
-- re-run idempotent (see migrate.ts) — this statement running a second
-- time for real would mean `schema_migrations` was desynced from the
-- database's actual state, and a same-named table already existing then is
-- exactly the case that must fail loudly rather than silently succeed:
-- an unverified pre-existing `users` table could be missing this
-- constraint, have different columns, or otherwise not match what every
-- later Feature querying this table assumes.
CREATE TABLE users (
  address TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT users_address_format CHECK (address ~ '^0x[0-9a-f]{40}$')
);
