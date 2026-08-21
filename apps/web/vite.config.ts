/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Load .env from the repo root instead of apps/web, so a single
  // .env.example/.env at the root covers every module (README T-007).
  envDir: "../../",
  test: {
    environment: "jsdom",
    globals: false,
  },
});
