-- Feature 4 (wallet-identity), T-403.
-- One-time-use nonce storage per specs/04-wallet-identity/design.md and F-405
-- ("nonce 使用后立即失效，不可重复验证").
--
-- `consumed` + `expires_at` are checked together in the same UPDATE
-- statement that flips `consumed` to true (see nonce.store.ts consumeNonce),
-- so "consume" is race-safe: two concurrent verify requests for the same
-- nonce can both attempt the UPDATE, but only one will find a row still
-- matching `consumed = false` thanks to Postgres row-level locking, and the
-- second gets zero rows back.
--
-- Deliberately no IF NOT EXISTS (see 0001_create_users.sql's comment for
-- the full rationale — an already-existing, unverified `auth_nonces` table
-- must fail the migration loudly, not be silently accepted and recorded as
-- applied).
CREATE TABLE auth_nonces (
  id BIGSERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT false,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT auth_nonces_address_format CHECK (address ~ '^0x[0-9a-f]{40}$')
);

-- A nonce value must be unique so consumeNonce's WHERE address = $1 AND
-- nonce = $2 lookup is unambiguous even if it were ever queried by nonce
-- alone.
CREATE UNIQUE INDEX IF NOT EXISTS auth_nonces_nonce_key ON auth_nonces (nonce);

-- Partial index: only unconsumed rows are ever looked up by address (to
-- supersede them on re-issue, see nonce.store.ts issueNonce). Because
-- issueNonce supersedes any prior unconsumed nonce before inserting a new
-- one, at most one unconsumed row per address exists at a time, keeping
-- this index small regardless of how many consumed/expired rows accumulate.
CREATE INDEX IF NOT EXISTS auth_nonces_address_unconsumed_idx
  ON auth_nonces (address)
  WHERE consumed = false;
