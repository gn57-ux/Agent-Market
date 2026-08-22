-- Feature 4 (wallet-identity), T-404.
-- Session storage per specs/04-wallet-identity/design.md's "登录时签名一次，换取
-- 会话令牌" decision. Only `token_hash` is stored — never the raw token — so a
-- database read (backup, replica, leaked dump) can never hand out a live,
-- usable session; the raw token only ever exists in memory and in the
-- one-time /auth/verify response (AC-405: no long-lived plaintext credential
-- storage).
--
-- `revoked_at` exists now so T-405's logout endpoint has something to write
-- to without a further migration — this table's own INSERT (session.service.ts
-- issueSession) is T-404's scope; reading/revoking it is T-405's.
--
-- Deliberately no IF NOT EXISTS (see 0001_create_users.sql's comment for the
-- rationale: an unverified pre-existing same-named table must fail the
-- migration loudly, not be silently accepted).
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES users (address),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

-- T-405's session-validity check (and any admin/debug lookup) queries by
-- address; only non-revoked, non-expired rows are ever relevant to that
-- check, so the partial index (mirroring auth_nonces' own unconsumed-only
-- index in 0002) keeps it small regardless of how many expired/revoked
-- sessions accumulate over time.
CREATE INDEX IF NOT EXISTS sessions_address_active_idx
  ON sessions (address)
  WHERE revoked_at IS NULL;
