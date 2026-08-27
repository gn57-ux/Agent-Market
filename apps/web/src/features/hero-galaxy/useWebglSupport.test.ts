import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isWebglSupported, useWebglSupport } from "./useWebglSupport.js";

describe("isWebglSupported", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when the canvas can produce a webgl2 or webgl context", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((id: string) =>
      id === "webgl2" ? ({} as unknown as RenderingContext) : null,
    );

    expect(isWebglSupported()).toBe(true);
  });

  it("returns false when getContext returns null for both webgl2 and webgl", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);

    expect(isWebglSupported()).toBe(false);
  });

  it("returns false when getContext throws (some browsers throw instead of returning null)", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("WebGL blocked");
    });

    expect(isWebglSupported()).toBe(false);
  });
});

describe("useWebglSupport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reflects isWebglSupported()'s result", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    const { result } = renderHook(() => useWebglSupport());
    expect(result.current).toBe(false);
  });
});
