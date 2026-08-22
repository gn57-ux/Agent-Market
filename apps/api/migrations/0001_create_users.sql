-- Feature 4 (wallet-identity), T-403.
-- users table per specs/04-wallet-identity/design.md data model section.
--
-- Ethereum addresses are normalized to lowercase by the application layer
-- (see apps/api/src/modules/auth/nonce.store.ts normalizeAddress) before any
-- read or write, so two differently-cased strings for the same wallet never
-- produce two rows here. The CHECK constraint enforces that invariant at the
-- data layer as a second line of defense against a caller that forgets to
-- normalize.
CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT users_address_format CHECK (address ~ '^0x[0-9a-f]{40}$')
);
