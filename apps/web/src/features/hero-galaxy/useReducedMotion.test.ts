import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReducedMotion } from "./useReducedMotion.js";

class FakeMediaQueryList extends EventTarget {
  matches: boolean;
  media: string;
  constructor(media: string, matches: boolean) {
    super();
    this.media = media;
    this.matches = matches;
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    super.addEventListener(type, listener);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    super.removeEventListener(type, listener);
  }
  setMatches(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

describe("useReducedMotion", () => {
  let mediaQueryList: FakeMediaQueryList;

  beforeEach(() => {
    mediaQueryList = new FakeMediaQueryList("(prefers-reduced-motion: reduce)", false);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => {
        mediaQueryList.media = query;
        return mediaQueryList;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the initial OS preference", () => {
    mediaQueryList.matches = true;
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("updates live when the preference changes after mount", () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      mediaQueryList.setMatches(true);
    });

    expect(result.current).toBe(true);
  });

  it("removes the change listener on unmount", () => {
    const removeSpy = vi.spyOn(mediaQueryList, "removeEventListener");
    const { unmount } = renderHook(() => useReducedMotion());

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
