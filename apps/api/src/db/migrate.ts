import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

// --- Migration approach: decision record (T-403) ---------------------------
//
// Two options were compared for how apps/api applies schema changes to
// PostgreSQL. This choice sets the pattern every later Feature (5-10, each
// adding its own tables) will follow, so it is treated as a "compare at
// least two directionally different approaches" decision per this project's
// CLAUDE.md, not a default pick.
//
// Option A (chosen): raw `pg` driver + this hand-rolled runner.
//   - Interface complexity: one function (`runMigrations`) plus a
//     `schema_migrations` tracking table. Migration files are plain `.sql`,
//     no DSL to learn.
//   - Dependencies: adds only `pg` (+ `@types/pg`), which is needed
//     regardless of migration strategy since nonce.store.ts/users.store.ts
//     need a query client anyway. No extra migration-library dependency.
//   - Testability: `runMigrations(pool, dir)` takes its dependencies as
//     arguments, so it's trivially callable against a real (or later,
//     testcontainers-style) Postgres in tests without CLI/config plumbing.
//   - Migration/rollback cost: no down-migrations — matches this project's
//     stated stance (git-workflow.md: destructive schema changes require
//     human review/confirmation, not an automated `down`). Forward-only
//     `.sql` files are the simplest artifact to review in a PR.
//   - Matches CLAUDE.md's "stay lean until proven otherwise": apps/api's
//     only dependencies so far are fastify + zod; this adds the minimum
//     needed for two tables, rather than a library's full feature surface
//     (seeding, rollback, config file) for a schema this simple.
//
// Option B (not chosen): a migration library (node-pg-migrate,
// postgres-migrations, etc.).
//   - Gives rollback/seeding support and a maintained runner, but adds a
//     dependency plus its own config/DSL surface (JS migration files or a
//     specific SQL dialect, a config file, a CLI) for a two-table schema
//     that doesn't need any of those features yet.
//   - Revisit if/when a later Feature genuinely needs something this runner
//     doesn't provide (e.g. programmatic down-migrations, parallel-safe
//     locking across multiple deploying instances) — at that point the
//     tradeoff shifts and a library earns its dependency cost.
// ----------------------------------------------------------------------------

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATIONS_TABLE = "schema_migrations";

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((file) => file.endsWith(".sql")).sort();
}

/**
 * Applies every `*.sql` file in `migrationsDir` (sorted by filename — files
 * are named with a numeric prefix, e.g. `0001_create_users.sql`) that is not
 * yet recorded in `schema_migrations`. Each file runs inside its own
 * transaction together with the bookkeeping INSERT into
 * `schema_migrations`, so a mid-file failure rolls back cleanly and a later
 * re-run retries only the missing file(s).
 *
 * Idempotency ("迁移可重复执行", tasks.md T-403) holds at two levels:
 *   1. This loop skips any filename already present in `schema_migrations`.
 *   2. Every DDL statement inside the `.sql` files additionally uses
 *      `IF NOT EXISTS`, so even a manually-edited/out-of-sync
 *      `schema_migrations` table can't produce a "relation already exists"
 *      error on re-run.
 */
export async function runMigrations(pool: Pool, migrationsDir: string): Promise<MigrationResult> {
  await ensureMigrationsTable(pool);
  const files = await listMigrationFiles(migrationsDir);
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM ${MIGRATIONS_TABLE}`);
  const appliedSet = new Set(rows.map((row) => row.id));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      alreadyApplied.push(file);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return { applied, alreadyApplied };
}
