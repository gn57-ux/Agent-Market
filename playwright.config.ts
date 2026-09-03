import { defineConfig, devices } from "@playwright/test";

/**
 * Feature 15 (T-1504) — real browser E2E for the Cocos personal office.
 * Runs against `apps/web`'s real production build served by `vite preview`
 * (the `apps/office-cocos` static bundle lives under `apps/web/public/`, so
 * this is the same artifact a real deployment would serve). No mocked
 * `window.postMessage` — Playwright drives a real Chromium instance, the
 * real iframe, and the real Cocos WebGL/Canvas runtime.
 *
 * `RUN_HARDHAT_E2E_TESTS`-style opt-in isn't needed here (no chain
 * dependency for the mock-mode scenarios); this suite requires a real
 * browser binary (`pnpm exec playwright install chromium`, already done)
 * and a real built `apps/web/dist` (the `webServer` below builds it if
 * missing — see `command`).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --filter @agent-market/web preview -- --port 4173 --host 127.0.0.1 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
