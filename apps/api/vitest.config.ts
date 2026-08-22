import { defineConfig } from "vitest/config";

export default defineConfig({
  // Load .env from the repo root, consistent with apps/web/vite.config.ts
  // and this package's dev/start scripts (README T-007).
  envDir: "../../",
  test: {
    environment: "node",
    globals: false,
  },
});
