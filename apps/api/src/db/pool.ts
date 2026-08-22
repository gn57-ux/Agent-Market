import { Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * Shared type for "anything with pg's `.query()` method" — a plain `Pool`
 * (auto-acquires/releases a client per call) or a `PoolClient` already
 * checked out for a manually-managed transaction. Store functions
 * (nonce.store.ts, users.store.ts, session.service.ts) accept this instead
 * of `Pool` specifically so a caller that needs several of them to commit
 * or roll back together (T-404's completeLogin.ts) can pass the same
 * `PoolClient` through all of them, without those modules needing to know
 * anything about transactions themselves.
 */
export type Queryable = Pick<Pool | PoolClient, "query">;

let pool: Pool | undefined;

function buildConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env at the repo root — " +
        "apps/api's dev/start scripts load it automatically via --env-file-if-exists.",
    );
  }
  return { connectionString };
}

/**
 * Single shared connection pool for apps/api. Every module that needs
 * PostgreSQL access should call `getPool()` rather than constructing its own
 * `pg.Pool` — pool sizing/lifecycle is one piece of design knowledge with one
 * owner (this module), not something each caller reimplements (CLAUDE.md
 * 原则 6: 设计知识只能有一个归属).
 *
 * The pool is created lazily on first use so importing this module has no
 * side effect (e.g. during `tsc --noEmit` or when a test only needs the
 * types) and so `DATABASE_URL` is read at call time, not import time.
 */
export function getPool(): Pool {
  pool ??= new Pool(buildConfig());
  return pool;
}

/**
 * Closes the shared pool. Intended for test teardown and graceful process
 * shutdown; not required for normal request handling.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
