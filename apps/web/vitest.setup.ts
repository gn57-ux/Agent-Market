import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @testing-library/react's auto-cleanup relies on detecting a global
// `afterEach`, which we don't inject (test.globals stays false so every
// test file keeps explicit `import { describe, it, expect } from "vitest"`).
// Register cleanup explicitly instead, so each test starts from an empty DOM.
afterEach(() => {
  cleanup();
});
