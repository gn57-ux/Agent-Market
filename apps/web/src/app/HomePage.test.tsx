import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { HomePage } from "./HomePage.js";
import { router } from "./router.js";

// jsdom has no WebGL implementation — HTMLCanvasElement.getContext("webgl"/
// "webgl2") genuinely returns null here, so `useWebglSupport()` correctly
// reports unsupported and `StaticFallback` renders the static composition
// without any mocking. Same real (not simulated) jsdom behavior Feature 3's
// own component-level tests already rely on.
describe("HomePage (real route integration)", () => {
  it("renders the Hero gate at the real index route", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HomePage />
      </MemoryRouter>,
    );

    const gate = document.querySelector("[data-hero-static-fallback-gate]");
    expect(gate).toBeTruthy();
    expect(gate?.getAttribute("data-hero-static-fallback-gate")).toBe("static");
  });

  it("renders the headline and nav as plain DOM content, not canvas-drawn text", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Agent Market", level: 1 })).toBeTruthy();
    expect(screen.getByText(/浏览/)).toBeTruthy();
  });

  it("the CTA links point to real app routes, not a placeholder scroll target", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HomePage />
      </MemoryRouter>,
    );

    const agentsLink = screen.getByRole("link", { name: "Agent 市场" });
    const createLink = screen.getByRole("link", { name: "发布一个 Agent" });
    expect(agentsLink.getAttribute("href")).toBe("/agents");
    expect(createLink.getAttribute("href")).toBe("/agents/new");
  });

  it("the static fallback composition renders inside the Hero gate without breaking the page's own content (AC-303/AC-305 regression)", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HomePage />
      </MemoryRouter>,
    );

    // Headline/nav still present alongside the static composition — the
    // WebGL-unsupported fallback path (real under jsdom) must not have
    // replaced or hidden the page's actual content.
    expect(screen.getByRole("heading", { name: "Agent Market", level: 1 })).toBeTruthy();
    expect(document.querySelector("[data-static-fallback-composition]")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agent 市场" })).toBeTruthy();
  });

  it("headline renders before the static composition in DOM order (children-first, matches StaticFallback's own contract)", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HomePage />
      </MemoryRouter>,
    );

    const heading = screen.getByRole("heading", { name: "Agent Market", level: 1 });
    const staticComposition = document.querySelector("[data-static-fallback-composition]");
    if (!staticComposition) {
      throw new Error("expected the static composition to be present under jsdom");
    }
    const position = heading.compareDocumentPosition(staticComposition);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("router.tsx (real route table, unaffected by the Hero integration)", () => {
  it("still registers every pre-existing route alongside the Hero-bearing index route", () => {
    const rootRoute = router.routes[0];
    if (!rootRoute?.children) {
      throw new Error("expected the root route to have children");
    }
    const paths = rootRoute.children.map((child) =>
      "index" in child && child.index ? "" : ((child as { path?: string }).path ?? ""),
    );

    expect(paths).toContain("");
    expect(paths).toContain("agents");
    expect(paths).toContain("agents/new");
    expect(paths).toContain("agents/:agentId");
    expect(paths).toContain("agents/:agentId/edit");
    expect(paths).toContain("tasks");
    expect(paths).toContain("tasks/new");
    expect(paths).toContain("tasks/mine");
    expect(paths).toContain("tasks/accepted");
    expect(paths).toContain("tasks/:taskId");
  });
});
