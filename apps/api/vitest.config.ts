import { defineConfig } from "vitest/config";

export default defineConfig({
  // Load .env from the repo root, consistent with apps/web/vite.config.ts
  // and this package's dev/start scripts (README T-007).
  envDir: "../../",
  test: {
    environment: "node",
    globals: false,
    // The two *.integration.test.ts suites (opt-in via
    // RUN_DB_INTEGRATION_TESTS=1) share one PostgreSQL database: both run
    // migrations and both DROP the same tables in afterAll. Vitest's default
    // per-file parallelism would let them race — duplicate migration
    // bookkeeping, concurrent DDL, or one suite dropping tables the other is
    // still using. Running files sequentially is the simplest fix for a
    // package this small (Codex review, T-403 round 1, P2).
    fileParallelism: false,
  },
});
