import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: "../../",
  test: {
    environment: "node",
    globals: false,
    // pg-boss's own schema/migration bookkeeping runs against the same
    // shared TEST_DATABASE_URL every other integration suite in this
    // monorepo uses — same fileParallelism:false discipline as
    // apps/api/vitest.config.ts and apps/indexer/vitest.config.ts, for
    // the identical reason (avoid concurrent-file races against one
    // shared database).
    fileParallelism: false,
  },
});
