import { render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeroCanvas } from "./HeroCanvas.js";

// HeroCanvas dynamically imports the real IntentRoutingGalaxy module (which
// needs a WebGL context IntentRoutingGalaxy.test.ts already fakes at the
// `three` level). For HeroCanvas's own unit, we only care about the
// lifecycle glue it owns, so we replace the scene module wholesale with a
// spy-backed fake GalaxyHandle.
const mountSpy = vi.fn();
const pauseSpy = vi.fn();
const resumeSpy = vi.fn();
const disposeSpy = vi.fn();
const createIntentRoutingGalaxySpy = vi.fn((options?: unknown) => {
  void options;
  return {
    mount: mountSpy,
    pause: pauseSpy,
    resume: resumeSpy,
    dispose: disposeSpy,
  };
});

vi.mock("./scene/IntentRoutingGalaxy.js", () => ({
  createIntentRoutingGalaxy: (options?: unknown) => createIntentRoutingGalaxySpy(options),
}));

// jsdom does not implement IntersectionObserver.
let intersectionCallback: IntersectionObserverCallback | null = null;
const observeSpy = vi.fn();
const disconnectSpy = vi.fn();

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
  observe = observeSpy;
  disconnect = disconnectSpy;
  unobserve = vi.fn();
  takeRecords = vi.fn(() => []);
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

beforeEach(() => {
  mountSpy.mockClear();
  pauseSpy.mockClear();
  resumeSpy.mockClear();
  disposeSpy.mockClear();
  createIntentRoutingGalaxySpy.mockClear();
  observeSpy.mockClear();
  disconnectSpy.mockClear();
  intersectionCallback = null;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  setDocumentHidden(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HeroCanvas", () => {
  it("dynamically loads the scene module and mounts exactly once", async () => {
    const { unmount } = render(<HeroCanvas />);

    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    expect(createIntentRoutingGalaxySpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("forwards reducedMotion into GalaxyOptions", async () => {
    const { unmount } = render(<HeroCanvas reducedMotion phaseDurationMs={1200} />);

    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    // T-305: GalaxyOptions now always carries an onContextLost wrapper (see
    // the ref-forwarding fix above), so this asserts the T-304-owned fields
    // via objectContaining rather than an exact-shape match.
    expect(createIntentRoutingGalaxySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reducedMotion: true,
        phaseDurationMs: 1200,
      }),
    );

    unmount();
  });

  it("pauses when the container leaves the viewport, resumes when it returns", async () => {
    const { unmount } = render(<HeroCanvas />);
    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    if (!intersectionCallback) {
      throw new Error("expected IntersectionObserver to have been constructed");
    }
    const onIntersect = intersectionCallback;

    // mount() starts the render loop, but the container's real intersection
    // state is unknown until the observer's first callback — so the
    // component conservatively pauses immediately after mount rather than
    // assuming visible (see the "overlapping conditions" test below for why
    // an optimistic default would be wrong).
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    pauseSpy.mockClear();

    onIntersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as never);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).not.toHaveBeenCalled();

    onIntersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("pauses when the tab is hidden, resumes when visible again", async () => {
    const { unmount } = render(<HeroCanvas />);
    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    if (!intersectionCallback) {
      throw new Error("expected IntersectionObserver to have been constructed");
    }
    // Establish "in viewport" first so visibility is the only variable this
    // test exercises (see note above about the post-mount default pause).
    intersectionCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
    pauseSpy.mockClear();
    resumeSpy.mockClear();

    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pauseSpy).toHaveBeenCalledTimes(1);

    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("only resumes when BOTH the tab is visible AND the container is intersecting (Codex review regression)", async () => {
    // The bug: two independent pause()/resume() triggers could override
    // each other — e.g. the tab becoming visible again while the canvas
    // was still scrolled offscreen would incorrectly resume it (and vice
    // versa). Both conditions must independently gate resume().
    const { unmount } = render(<HeroCanvas />);
    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    if (!intersectionCallback) {
      throw new Error("expected IntersectionObserver to have been constructed");
    }
    const onIntersect = intersectionCallback;
    pauseSpy.mockClear();
    resumeSpy.mockClear();

    // Tab hidden AND offscreen.
    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    onIntersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as never);
    resumeSpy.mockClear();

    // Tab becomes visible again, but the container is still offscreen:
    // must NOT resume.
    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resumeSpy).not.toHaveBeenCalled();

    // Container scrolls back into view, but the tab is hidden again: must
    // NOT resume.
    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    onIntersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
    expect(resumeSpy).not.toHaveBeenCalled();

    // Only once both conditions agree does it resume.
    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("disposes exactly once and stops reacting to events on unmount", async () => {
    const { unmount } = render(<HeroCanvas />);
    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));

    unmount();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    // No leaked visibilitychange listener: toggling visibility post-unmount
    // must not reach the disposed handle's pause()/resume().
    pauseSpy.mockClear();
    resumeSpy.mockClear();
    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("T-305: forwards onContextLost so GalaxyOptions.onContextLost invokes it", async () => {
    const onContextLost = vi.fn();
    const { unmount } = render(<HeroCanvas onContextLost={onContextLost} />);

    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    const passedOptions = createIntentRoutingGalaxySpy.mock.calls[0]?.[0] as
      { onContextLost?: () => void } | undefined;
    passedOptions?.onContextLost?.();
    expect(onContextLost).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("T-305: onContextLost stays current across re-renders without remounting the scene (Codex review regression)", async () => {
    const firstOnContextLost = vi.fn();
    const secondOnContextLost = vi.fn();
    const { rerender, unmount } = render(<HeroCanvas onContextLost={firstOnContextLost} />);

    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    const passedOptions = createIntentRoutingGalaxySpy.mock.calls[0]?.[0] as
      { onContextLost?: () => void } | undefined;

    // Re-render with a NEW onContextLost identity but the SAME
    // reducedMotion/phaseDurationMs — the effect must not rerun (no second
    // mount), yet invoking the wrapper GalaxyOptions.onContextLost was
    // given at the ORIGINAL mount must still reach the LATEST callback.
    rerender(<HeroCanvas onContextLost={secondOnContextLost} />);
    expect(mountSpy).toHaveBeenCalledTimes(1);

    passedOptions?.onContextLost?.();
    expect(firstOnContextLost).not.toHaveBeenCalled();
    expect(secondOnContextLost).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("T-305: calls onLoadError when the scene module fails to become available", async () => {
    const onLoadError = vi.fn();
    createIntentRoutingGalaxySpy.mockImplementationOnce(() => {
      throw new Error("scene chunk failed to load");
    });

    const { unmount } = render(<HeroCanvas onLoadError={onLoadError} />);

    await waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1));
    expect(mountSpy).not.toHaveBeenCalled();

    unmount();
  });

  it("T-305: onLoadError stays current across re-renders without remounting the scene (Codex review regression)", async () => {
    const firstOnLoadError = vi.fn();
    const secondOnLoadError = vi.fn();
    createIntentRoutingGalaxySpy.mockImplementationOnce(() => {
      throw new Error("scene chunk failed to load");
    });

    const { rerender } = render(<HeroCanvas onLoadError={firstOnLoadError} />);

    // Same reducedMotion/phaseDurationMs, new callback identity — must not
    // remount (createIntentRoutingGalaxySpy's queued throw is only
    // consumed once, by the original mount attempt).
    rerender(<HeroCanvas onLoadError={secondOnLoadError} />);

    await waitFor(() => expect(secondOnLoadError).toHaveBeenCalledTimes(1));
    expect(firstOnLoadError).not.toHaveBeenCalled();
  });

  it("T-305: does not call onLoadError after the component has unmounted", async () => {
    const onLoadError = vi.fn();
    // No mockImplementationOnce queued here: the `cancelled` guard is
    // expected to stop this effect before createIntentRoutingGalaxySpy is
    // ever called, so a queued throwing implementation would just leak
    // unconsumed into a later test.

    // Unmount immediately, before the dynamic import's microtask chain has
    // a chance to resolve — `cancelled` must already be true by the time
    // the rejection would otherwise reach `.catch()`.
    const { unmount } = render(<HeroCanvas onLoadError={onLoadError} />);
    unmount();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onLoadError).not.toHaveBeenCalled();
  });

  it("T-308: forwards style onto the mount container so a caller can reserve real height (Codex review regression)", async () => {
    // Codex review (P1): with no way to give the container real height, the
    // deep module's resizeToContainer() observed a zero-height container
    // and clamped it to 1px, rendering the production galaxy invisible.
    const { container, unmount } = render(
      <HeroCanvas style={{ minHeight: "420px", width: "100%" }} />,
    );
    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));

    const mountDiv = container.firstElementChild as HTMLElement;
    expect(mountDiv.style.minHeight).toBe("420px");
    expect(mountDiv.style.width).toBe("100%");

    unmount();
  });

  it("does not double-mount under React StrictMode's dev-mode double-invoke", async () => {
    const { unmount } = render(
      <StrictMode>
        <HeroCanvas />
      </StrictMode>,
    );

    await waitFor(() => expect(mountSpy).toHaveBeenCalledTimes(1));
    expect(createIntentRoutingGalaxySpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).not.toHaveBeenCalled();

    unmount();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
