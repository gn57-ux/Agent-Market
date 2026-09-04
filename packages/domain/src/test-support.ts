/**
 * Shared guard for every `*.integration.test.ts`/`*.hardhat.e2e.test.ts`
 * suite across this monorepo's TS apps (`apps/api`, and — Feature 18,
 * T-1805 — `apps/indexer`), which run real DDL/DML (including dropping
 * tables in `afterAll`) against a real PostgreSQL database. Every such
 * suite must call this — not construct `pg.Pool` directly from an env var
 * itself — so "refuse to run destructively without an explicit,
 * confirmed-safe target database" is single-sourced here rather than
 * reimplemented per app (CLAUDE.md 原则 6). Originally lived in
 * `apps/api/src/db/test-support.ts`; moved into `packages/domain` once
 * `apps/indexer` became a second real, independently-deployable consumer
 * needing the exact same guard (same reasoning as this package's
 * `chain-events/` move).
 *
 * Codex review (T-403 round 1, P1): the original version let
 * `RUN_DB_INTEGRATION_TESTS=1` opt in without also requiring an explicit
 * connection string, so `pg` could silently fall back to `PG*` env vars or
 * a local Unix socket default.
 *
 * Codex review (T-403 round 2, P1, still unresolved after round 1's fix):
 * requiring `DATABASE_URL` specifically isn't enough either — every
 * consuming package's own `vitest.config.ts` sets `envDir: "../../"`,
 * which auto-loads the repo root `.env`. That file's whole purpose is to
 * hold the app's normal, real `DATABASE_URL` (per `.env.example`'s
 * documented convention) — so on any machine where a developer has that
 * configured for actually running the API, opting into these tests via
 * `RUN_DB_INTEGRATION_TESTS=1` alone would point the destructive
 * `afterAll` DROP TABLE at that same real database, not a throwaway one.
 *
 * Fixed by requiring a SEPARATE `TEST_DATABASE_URL` env var, which nothing
 * else in this project ever auto-populates — an operator has to set it
 * deliberately and specifically for this purpose, so there is no path by
 * which the app's ordinary dev-database configuration silently satisfies
 * it. As a second, independent line of defense (not merely trusting the
 * variable name), the target database's name itself must also look like a
 * test database (see `isLikelyTestDatabaseName`) — catching the case where
 * an operator points `TEST_DATABASE_URL` at the wrong database by copy-paste
 * mistake.
 *
 * Callers must invoke this lazily (inside a `beforeAll`, not at
 * describe-body top level) — Vitest's `describe.skip` still executes the
 * describe callback body to register (skipped) test cases, but does not run
 * hooks declared inside it, so this only actually throws when the suite is
 * genuinely opted in and about to run.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "RUN_DB_INTEGRATION_TESTS=1 requires an explicit TEST_DATABASE_URL pointing at a " +
        "database you have confirmed is safe to write to and have data dropped from " +
        "(a dedicated local throwaway/test database — NOT this project's regular " +
        "DATABASE_URL, even if you have that configured; that's your real dev database, " +
        "and this suite will DROP TABLE against whatever it points at).",
    );
  }
  const databaseName = parseDatabaseName(url);
  if (!databaseName || !isLikelyTestDatabaseName(databaseName)) {
    throw new Error(
      `TEST_DATABASE_URL's database name ("${databaseName ?? "(unparseable)"}") doesn't look ` +
        'like a dedicated test database (expected it to contain "test", e.g. ' +
        '"agent_market_test"). Refusing to run destructive DDL against a database that ' +
        "wasn't clearly named for this purpose — if this really is a disposable test " +
        "database, rename it to make that unambiguous.",
    );
  }
  return url;
}

function parseDatabaseName(connectionString: string): string | undefined {
  try {
    const pathname = new URL(connectionString).pathname;
    const name = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    return name || undefined;
  } catch {
    return undefined;
  }
}

function isLikelyTestDatabaseName(databaseName: string): boolean {
  return /test/i.test(databaseName);
}
