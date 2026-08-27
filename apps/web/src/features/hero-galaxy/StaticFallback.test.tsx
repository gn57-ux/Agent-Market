import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticComposition, StaticFallback } from "./StaticFallback.js";

let webglSupported = true;
let reducedMotion = false;

vi.mock("./useWebglSupport.js", () => ({
  useWebglSupport: () => webglSupported,
}));
vi.mock("./useReducedMotion.js", () => ({
  useReducedMotion: () => reducedMotion,
}));

const heroCanvasSpy = vi.fn();
vi.mock("./HeroCanvas.js", () => ({
  HeroCanvas: (props: { onLoadError?: () => void; onContextLost?: () => void }) => {
    heroCanvasSpy(props);
    return <div data-testid="hero-canvas-stub" />;
  },
}));

// jsdom has no matchMedia; StaticFallback's local mobile-viewport hook and
// useReducedMotion both call it, so a minimal stub keeps every render in
// this file from throwing regardless of which branch each test exercises.
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

describe("StaticFallback", () => {
  beforeEach(() => {
    webglSupported = true;
    reducedMotion = false;
    heroCanvasSpy.mockClear();
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders HeroCanvas when WebGL is supported and reduced-motion is off", () => {
    render(<StaticFallback />);

    expect(screen.getByTestId("hero-canvas-stub")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /意图路由星图/ })).toBeNull();
  });

  it("T-308: passes HeroCanvas an explicit minHeight so the dynamic canvas isn't collapsed to ~0px (Codex review regression)", () => {
    render(<StaticFallback />);

    const passedProps = heroCanvasSpy.mock.calls[0]?.[0] as { style?: { minHeight?: string } };
    expect(passedProps.style?.minHeight).toBeTruthy();
    expect(passedProps.style?.minHeight).not.toBe("0px");
  });

  it("renders the static composition when WebGL is unsupported", () => {
    webglSupported = false;
    render(<StaticFallback />);

    expect(screen.getByRole("img", { name: /意图路由星图/ })).toBeTruthy();
    expect(screen.queryByTestId("hero-canvas-stub")).toBeNull();
  });

  it("renders the static composition when prefers-reduced-motion is on", () => {
    reducedMotion = true;
    render(<StaticFallback />);

    expect(screen.getByRole("img", { name: /意图路由星图/ })).toBeTruthy();
  });

  it("switches to the static composition when HeroCanvas reports a load error", () => {
    const { rerender } = render(<StaticFallback />);
    expect(screen.getByTestId("hero-canvas-stub")).toBeTruthy();

    const { onLoadError } = heroCanvasSpy.mock.calls[0]?.[0] ?? {};
    if (!onLoadError) {
      throw new Error("expected HeroCanvas to receive onLoadError");
    }
    onLoadError();
    rerender(<StaticFallback />);

    expect(screen.getByRole("img", { name: /意图路由星图/ })).toBeTruthy();
  });

  it("switches to the static composition when HeroCanvas reports context loss", () => {
    const { rerender } = render(<StaticFallback />);

    const { onContextLost } = heroCanvasSpy.mock.calls[0]?.[0] ?? {};
    if (!onContextLost) {
      throw new Error("expected HeroCanvas to receive onContextLost");
    }
    onContextLost();
    rerender(<StaticFallback />);

    expect(screen.getByRole("img", { name: /意图路由星图/ })).toBeTruthy();
  });

  it("renders children (headline/CTA slot) above the visual in both branches", () => {
    const { rerender } = render(
      <StaticFallback>
        <h1>示例标题</h1>
      </StaticFallback>,
    );
    expect(screen.getByRole("heading", { name: "示例标题" })).toBeTruthy();

    webglSupported = false;
    rerender(
      <StaticFallback>
        <h1>示例标题</h1>
      </StaticFallback>,
    );
    expect(screen.getByRole("heading", { name: "示例标题" })).toBeTruthy();
  });

  it("does not throw when matchMedia is unavailable (defensive guard in both hooks)", () => {
    vi.unstubAllGlobals();
    expect(() => render(<StaticFallback />)).not.toThrow();
  });
});

describe("StaticComposition", () => {
  it("desktop variant shows all three candidate slots (two TOP_SCORE + one EXPLORATION)", () => {
    render(<StaticComposition variant="desktop" />);

    expect(screen.getByText("候选 A · 高分")).toBeTruthy();
    expect(screen.getByText("候选 B · 高分")).toBeTruthy();
    expect(screen.getByText("候选 C · 新人探索")).toBeTruthy();
    expect(screen.getByText("接单质押 6%")).toBeTruthy();
    expect(screen.getByText("链上结算完成")).toBeTruthy();
  });

  it("mobile variant still preserves all three candidate slot semantics (F-307/Codex review regression)", () => {
    // Codex review (P2): an earlier version dropped the EXPLORATION slot on
    // mobile, contradicting requirements.md's explicit "保留任务核心和三个
    // 推荐槽位的语义" (preserve the task core AND three recommendation
    // slots' semantics). Mobile density is expressed via smaller/tighter
    // styling elsewhere, not by removing a required slot.
    render(<StaticComposition variant="mobile" />);

    expect(screen.getByText("候选 A · 高分")).toBeTruthy();
    expect(screen.getByText("候选 B · 高分")).toBeTruthy();
    expect(screen.getByText("候选 C · 新人探索")).toBeTruthy();
    expect(screen.getByText("接单质押 6%")).toBeTruthy();
    expect(screen.getByText("链上结算完成")).toBeTruthy();
  });

  it("labels the composition as a product-mechanism demo, not a real mainnet metric (AC-306)", () => {
    render(<StaticComposition variant="desktop" />);

    expect(screen.getByText(/产品机制演示/)).toBeTruthy();
    expect(screen.queryByText(/Mainnet Live/i)).toBeNull();
    expect(screen.queryByText(/TVL/i)).toBeNull();
  });
});
