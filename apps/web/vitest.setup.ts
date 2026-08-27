import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @testing-library/react's auto-cleanup relies on detecting a global
// `afterEach`, which we don't inject (test.globals stays false so every
// test file keeps explicit `import { describe, it, expect } from "vitest"`).
// Register cleanup explicitly instead, so each test starts from an empty DOM.
afterEach(() => {
  cleanup();
});

// jsdom does not implement `window.matchMedia` at all (unlike a real
// browser) — `ActionSheet`'s `useMediaQuery` calls it unconditionally on
// every render, so any test that mounts `ActionSheet` (directly, or via a
// consumer like `AcceptanceSection`/T-803's `AcceptConfirmContent` flow)
// would otherwise throw before ever reaching its own assertions, even when
// the test has no interest in the desktop/mobile distinction itself. This
// is a fixed "desktop" stub only — a test that specifically needs to
// exercise the mobile bottom-sheet layout or a live breakpoint crossing
// (see `ActionSheet.test.tsx`) overrides `window.matchMedia` itself, which
// simply reassigns over this default.
window.matchMedia =
  window.matchMedia ??
  ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
