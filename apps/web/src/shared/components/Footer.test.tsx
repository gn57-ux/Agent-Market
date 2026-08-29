import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Footer } from "./Footer.js";

describe("Footer", () => {
  it("renders the wordmark, link row, and copyright", () => {
    render(<Footer />);
    expect(screen.getByText("Agent Market")).toBeTruthy();
    // Not a real link (Codex review, N4, P2) — Privacy/Terms/Docs/Support
    // have no destination page yet, so this row is intentionally
    // non-interactive text, not an `<a>` that would silently no-op.
    expect(screen.getByText("Privacy")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Privacy" })).toBeNull();
    expect(screen.getByText(/© 2026 Agent Market/)).toBeTruthy();
  });
});
