import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "./pool.js";
import { runMigrations } from "./migrate.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const result = await runMigrations(pool, migrationsDir);
    console.log(`Applied: ${result.applied.length > 0 ? result.applied.join(", ") : "(none)"}`);
    console.log(
      `Already applied: ${result.alreadyApplied.length > 0 ? result.alreadyApplied.join(", ") : "(none)"}`,
    );
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
