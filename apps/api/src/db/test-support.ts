/**
 * Shared guard for the two `*.integration.test.ts` suites, which run real
 * DDL/DML (including dropping tables in `afterAll`) against
 * `process.env.DATABASE_URL`. Both suites must call this — not construct
 * `pg.Pool` directly with `process.env.DATABASE_URL` — so "refuse to run
 * destructively without an explicit, confirmed target database" is single-
 * sourced here rather than reimplemented per suite (CLAUDE.md 原则 6).
 *
 * Codex review (T-403 round 1, P1): the previous version let
 * `RUN_DB_INTEGRATION_TESTS=1` opt in without also requiring `DATABASE_URL`
 * — `pg` would then silently fall back to `PG*` env vars or a local Unix
 * socket default, meaning the destructive `afterAll` cleanup could hit
 * whatever database that fallback happened to resolve to. This throws
 * instead, so an operator who sets `RUN_DB_INTEGRATION_TESTS=1` without
 * `DATABASE_URL` gets a loud, explicit failure rather than a silent
 * connection to an unintended database.
 *
 * Callers must invoke this lazily (inside a `beforeAll`, not at
 * describe-body top level) — Vitest's `describe.skip` still executes the
 * describe callback body to register (skipped) test cases, but does not run
 * hooks declared inside it, so this only actually throws when the suite is
 * genuinely opted in and about to run.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "RUN_DB_INTEGRATION_TESTS=1 requires an explicit DATABASE_URL pointing at a " +
        "database you have confirmed is safe to write to and have data dropped from " +
        "(a local throwaway/test database, not a shared or production one). Refusing " +
        "to fall back to pg's default connection resolution (PG* env vars or a local " +
        "Unix socket), which could silently run destructive DDL against an unintended " +
        "database.",
    );
  }
  return url;
}
