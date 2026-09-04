import { Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * Same "one query-capable shape, either a whole pool or a checked-out
 * client" type as `apps/api/src/db/pool.ts`'s own `Queryable` — duplicated
 * here rather than imported, because `apps/api` cannot currently be
 * depended on as a typed library by another app in this workspace (its
 * `tsconfig.json` has no `declaration: true`, so it emits `.js` but no
 * `.d.ts` — confirmed while designing T-1805's `chain-events` move, which
 * is why that shared logic went to `packages/domain` instead). This type
 * itself is generic `pg` plumbing, not domain knowledge with a single
 * conceptual owner (CLAUDE.md 原则 6 is about business/design knowledge,
 * not about a five-line structural type every independently-deployed app
 * in a Node/`pg` monorepo commonly declares for itself).
 */
export type Queryable = Pick<Pool | PoolClient, "query">;

let pool: Pool | undefined;

function buildConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env at the repo root — " +
        "apps/indexer's dev/start scripts load it automatically via --env-file-if-exists.",
    );
  }
  return { connectionString };
}

/**
 * Single shared connection pool for apps/indexer, same lazy-construction
 * discipline as apps/api's getPool(): created on first use so importing
 * this module has no side effect, and DATABASE_URL is read at call time.
 */
export function getPool(): Pool {
  pool ??= new Pool(buildConfig());
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
