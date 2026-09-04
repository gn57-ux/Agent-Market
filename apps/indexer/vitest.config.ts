import { defineConfig } from "vitest/config";

export default defineConfig({
  // Load .env from the repo root, same convention as apps/api/vitest.config.ts.
  envDir: "../../",
  test: {
    environment: "node",
    globals: false,
    // Mirrors apps/api/vitest.config.ts's own reasoning (T-403 round 1,
    // P2): this package's own *.integration.test.ts / *.hardhat.e2e.test.ts
    // suites share the same real PostgreSQL database apps/api's suites do
    // (one shared TEST_DATABASE_URL), so file-level parallelism would let
    // them race on migrations/DDL/cleanup exactly the same way.
    fileParallelism: false,
  },
});
