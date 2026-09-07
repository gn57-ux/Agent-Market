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
  if (!pool) {
    pool = new Pool(buildConfig());
    // T-2307 (AC-2307), real fault-injection finding: node-postgres's own
    // documented behavior — an IDLE pooled client that the server
    // terminates (a real, ordinary event: `docker stop`/a restart/
    // `pg_terminate_backend`, not a bug on Postgres's side) emits an
    // `'error'` event on the Pool. With no listener attached, Node's
    // default "unhandled 'error' event" behavior is to THROW, which
    // crashes this entire process — verified by literally stopping a real
    // Postgres container mid-test and watching the whole API process die
    // (`Emitted 'error' event on BoundPool instance` in the crash log),
    // not merely a failed query. A query actively in flight when the
    // connection drops still rejects normally through its own Promise
    // (already handled by each call site's existing try/catch, e.g.
    // `server.ts`'s poller `onError` callbacks) — this listener only
    // covers the OTHER case pg's own docs warn about: an idle client with
    // no in-flight query, which has no Promise for the error to reject
    // through.
    pool.on("error", (error) => {
      // Logs only the message/name — never the raw `error` object. pg's
      // own error shape here carries a `client` field (the actual
      // `pg.Client` whose idle connection just died), and that Client's
      // internal connection state includes the real password DATABASE_URL
      // resolved to (AC-2303: "没有任何密钥以明文形式出现在...日志中" — a
      // raw `console.error("...", error)` would have serialized that
      // Client, and with it the credential, straight into the log; caught
      // during this Task's own real fault-injection test run, which
      // printed exactly that object).
      console.error("db pool: idle client error (connection likely dropped)", {
        message: error.message,
        name: error.name,
      });
    });
  }
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
