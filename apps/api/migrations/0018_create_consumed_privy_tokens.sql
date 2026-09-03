-- Feature 16 (identity-agent-review-funds-dashboard), T-1601.
-- N4 round-1 real finding (P1): a still-valid Privy access token could be
-- redeemed into an unlimited number of application sessions via repeated
-- POST /auth/verify/privy calls -- nothing tracked "this specific token has
-- already been exchanged for a session". This table gives
-- PrivyIdentityProvider.completeAuth the same one-time-consumption
-- guarantee auth_nonces already gives SIWE's nonce (see
-- 0002_create_auth_nonces.sql) -- a token can only ever be successfully
-- exchanged for a session once.
--
-- Deliberately keyed on a hash of the raw access token (SHA-256, hex),
-- never the token itself -- this project's hard security constraint is that
-- no credential/token material is ever persisted in the business database
-- (docs/security/privy-embedded-wallet-key-management.md), and a hash is
-- sufficient to detect reuse without being reversible to the original
-- token.
--
-- Deliberately no IF NOT EXISTS (see 0001_create_users.sql's comment for
-- the full rationale -- an already-existing, unverified table must fail the
-- migration loudly, not be silently accepted and recorded as applied).
CREATE TABLE consumed_privy_tokens (
  token_hash TEXT PRIMARY KEY,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No TTL/cleanup job for now -- Privy access tokens are short-lived (on the
-- order of an hour), so rows here are only ever meaningfully checked within
-- that same short window; unbounded growth is a real but low-priority
-- concern deferred until real traffic volume shows it matters (matches
-- DEFERRED-ENGINEERING.md's stance on not pre-building infrastructure
-- without a proven need), not solved here.
