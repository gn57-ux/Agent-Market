import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// jsdom has no real WebGL context, so THREE.WebGLRenderer cannot construct
// against a real GPU here. We swap in a minimal fake renderer that
// implements just the surface IntentRoutingGalaxy actually calls
// (domElement, setPixelRatio, setSize, render, dispose), keeping every
// other THREE export (Scene, PerspectiveCamera, Mesh, ...) real. This
// proves the module's mount/pause/resume/dispose *contract* — the RAF
// lifecycle, DOM attach/detach, and resource cleanup calls — without
// depending on an actual WebGL implementation, which is out of scope for
// this unit (heavier visual/GPU testing belongs to later tasks).
const disposeSpy = vi.fn();
const renderSpy = vi.fn();
const setSizeSpy = vi.fn();
const setPixelRatioSpy = vi.fn();

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();

  class FakeWebGLRenderer {
    domElement = document.createElement("canvas");
    setPixelRatio(...args: unknown[]) {
      setPixelRatioSpy(...args);
    }
    setSize(...args: unknown[]) {
      setSizeSpy(...args);
    }
    render(...args: unknown[]) {
      renderSpy(...args);
    }
    dispose() {
      disposeSpy();
    }
  }

  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

// jsdom does not implement ResizeObserver.
class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe("createIntentRoutingGalaxy", () => {
  let rafSpy: MockInstance<typeof window.requestAnimationFrame>;
  let cafSpy: MockInstance<typeof window.cancelAnimationFrame>;
  let rafCallbacks: Array<(time: number) => void>;
  let nextRafId: number;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    rafCallbacks = [];
    nextRafId = 1;
    rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return nextRafId++;
    });
    cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    disposeSpy.mockClear();
    renderSpy.mockClear();
    setSizeSpy.mockClear();
    setPixelRatioSpy.mockClear();
  });

  afterEach(() => {
    rafSpy.mockRestore();
    cafSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  function flushOneFrame(time = 16): void {
    const callbacks = rafCallbacks.splice(0, rafCallbacks.length);
    callbacks.forEach((cb) => cb(time));
  }

  it("exposes exactly mount/pause/resume/dispose", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    expect(Object.keys(handle).sort()).toEqual(["dispose", "mount", "pause", "resume"]);
    expect(typeof handle.mount).toBe("function");
    expect(typeof handle.pause).toBe("function");
    expect(typeof handle.resume).toBe("function");
    expect(typeof handle.dispose).toBe("function");
  });

  it("mount() attaches the canvas to the container and starts the render loop", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });

    expect(() => handle.mount(container)).not.toThrow();

    expect(container.querySelector("canvas")).not.toBeNull();
    expect(rafSpy).toHaveBeenCalled();

    flushOneFrame();
    expect(renderSpy).toHaveBeenCalledTimes(1);

    handle.dispose();
  });

  it("pause() stops the render loop (no further frames scheduled after the in-flight one)", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    const container = document.createElement("div");
    handle.mount(container);

    handle.pause();
    expect(cafSpy).toHaveBeenCalled();

    rafSpy.mockClear();
    // Any callback still queued from before pause() should be a no-op and
    // must not re-schedule another frame.
    flushOneFrame();
    expect(rafSpy).not.toHaveBeenCalled();

    handle.dispose();
  });

  it("resume() restarts the render loop after pause()", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    const container = document.createElement("div");
    handle.mount(container);

    handle.pause();
    rafSpy.mockClear();
    handle.resume();
    expect(rafSpy).toHaveBeenCalled();

    handle.dispose();
  });

  it("dispose() cancels the RAF loop, removes the canvas, and disposes the renderer", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    const container = document.createElement("div");
    handle.mount(container);

    expect(container.querySelector("canvas")).not.toBeNull();

    handle.dispose();

    expect(cafSpy).toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    rafSpy.mockClear();
    flushOneFrame();
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("mount() sizes the canvas via updateStyle=true so its CSS box tracks the container at any DPR", async () => {
    // Codex review finding: `renderer.setSize(width, height, false)`
    // skipped writing the canvas's CSS width/height, so at
    // devicePixelRatio > 1 the canvas's CSS box was left unset instead of
    // matching the container. `updateStyle` must be true (or omitted,
    // since it defaults to true) so Three.js keeps the CSS box in sync.
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });

    handle.mount(container);

    expect(setSizeSpy).toHaveBeenCalledWith(800, 600, true);

    handle.dispose();
  });

  it("calling mount() a second time without dispose() throws", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    handle.mount(containerA);

    expect(() => handle.mount(containerB)).toThrow(/already mounted/);

    handle.dispose();
  });

  it("mounting/running/disposing with the T-302 scene content (task core, agent nodes, connection lines, scan wave) does not throw across several MATCHING-spanning frames", async () => {
    // T-302 added THREE.Mesh (task core, agent nodes, scan wave) and
    // THREE.Line (connection lines) objects to the scene, driven by phase.
    // This proves construction, several frames of phase-driven mutation
    // (including materials being swapped out under connection lines), and
    // dispose() all complete without throwing — the manual/visual
    // correctness itself is out of scope for this environment (no real
    // WebGL context), per this task's stated verification method.
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy({ phaseDurationMs: 100 });
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });

    expect(() => handle.mount(container)).not.toThrow();

    // Advance far enough (in simulated frame time) to pass through IDLE ->
    // INTENT_CREATED -> MATCHING and partway into MATCHING's scan sweep.
    let time = 0;
    for (let i = 0; i < 20; i += 1) {
      time += 25;
      expect(() => flushOneFrame(time)).not.toThrow();
    }

    expect(() => handle.dispose()).not.toThrow();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("a single huge-delta frame that skips straight past MATCHING settles qualification instead of throwing/hanging", async () => {
    // Codex review finding: a delayed RAF callback (e.g. tab backgrounded)
    // can deliver a delta large enough for phaseClock.tick() to advance
    // through several phases — including all the way past MATCHING — in
    // one call. The render loop must settle the MATCHING qualification
    // result deterministically in that case, not leave the node network
    // stuck at its pre-MATCHING state, and must not hang or throw doing so.
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy({ phaseDurationMs: 100 });
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });

    handle.mount(container);
    // First frame establishes lastFrameTime=null -> delta=0. The second
    // frame's huge delta (spanning far past MATCHING, well into later
    // phases) is where the skip-past-MATCHING path is exercised.
    expect(() => flushOneFrame(0)).not.toThrow();
    expect(() => flushOneFrame(50_000)).not.toThrow();

    expect(() => handle.dispose()).not.toThrow();
  });

  it("T-303: a full narrative cycle (IDLE..SETTLED and back to IDLE) mounts, animates, and disposes without throwing", async () => {
    // AC-301's stated verification method is human visual review — this
    // proves the mechanical contract (construction, per-frame mutation of
    // the T-303 candidate/staking/delivery/settlement visuals added on top
    // of T-301/T-302's scene, and cleanup) across every phase, including
    // the SETTLED -> IDLE wraparound and a second lap re-entering
    // CANDIDATES_SELECTED, so candidate re-selection on loop is exercised
    // too.
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy({ phaseDurationMs: 50 });
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });

    expect(() => handle.mount(container)).not.toThrow();

    // 8 phases * 50ms each = 400ms per lap. Run just over two full laps in
    // small steps so every phase (including EXECUTING/RESULT_RETURNED/
    // SETTLED, which read `phaseClock.progress` for the delivery particle)
    // gets several frames at varying progress values.
    let time = 0;
    for (let i = 0; i < 90; i += 1) {
      time += 10;
      expect(() => flushOneFrame(time)).not.toThrow();
    }

    expect(() => handle.pause()).not.toThrow();
    expect(() => handle.resume()).not.toThrow();

    for (let i = 0; i < 10; i += 1) {
      time += 10;
      expect(() => flushOneFrame(time)).not.toThrow();
    }

    expect(() => handle.dispose()).not.toThrow();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("T-303: a huge-delta frame that skips straight past CANDIDATES_SELECTED/STAKE_LOCKED still settles deterministically", async () => {
    // Same class of risk as the MATCHING-skip test above: a delayed RAF
    // callback can deliver a delta large enough to jump straight into (or
    // past) SETTLED. `ensureCandidatesComputed` must still produce a valid
    // candidate/accepted selection lazily rather than leaving the node
    // network in a stale pre-candidate-selection state, and must not throw.
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy({ phaseDurationMs: 50 });
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });

    handle.mount(container);
    expect(() => flushOneFrame(0)).not.toThrow();
    // 50ms/phase * 8 phases = 400ms/cycle; jump ~1.5 cycles in one delta,
    // landing well past CANDIDATES_SELECTED/STAKE_LOCKED into a later phase.
    expect(() => flushOneFrame(600)).not.toThrow();
    expect(() => flushOneFrame(650)).not.toThrow();

    expect(() => handle.dispose()).not.toThrow();
  });

  it("T-303: a huge-delta frame that skips straight past IDLE (SETTLED -> ... -> a later phase in one tick) still resets cycle state deterministically", async () => {
    // Codex review finding (P2): NarrativePhaseClock only exposes the
    // *final* phase reached after tick(), so a large enough delta can jump
    // from SETTLED straight past IDLE into INTENT_CREATED (or further)
    // without the phase ever literally equaling "IDLE" on any observed
    // frame — the IDLE branch's reset (candidate/accepted selection, task
    // core color, staking ring/particle visibility) would then never run,
    // leaking the previous cycle's settled visuals into the new cycle.
    // `renderFrame`'s explicit wraparound guard (phase-index regression or
    // transitions >= a full cycle) must catch this instead. This test
    // proves the fix doesn't throw/hang across that exact transition; the
    // internal visual state itself isn't inspectable through
    // `GalaxyHandle`'s intentionally narrow mount/pause/resume/dispose
    // surface (see this task's stated manual-visual-review verification
    // method) — confirmed correct by code inspection of resetCycleState's
    // call sites.
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy({ phaseDurationMs: 50 });
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });

    handle.mount(container);
    expect(() => flushOneFrame(0)).not.toThrow();
    // 50ms/phase * 8 phases = 400ms/cycle. Advance to SETTLED (phase index
    // 7, ~350-400ms in) with small steps first, then deliver one huge delta
    // that lands well into the next cycle without ever landing on IDLE.
    let time = 0;
    for (let i = 0; i < 36; i += 1) {
      time += 10;
      flushOneFrame(time);
    }
    time += 900; // jumps ~2.25 cycles ahead in a single tick
    expect(() => flushOneFrame(time)).not.toThrow();

    // A few more normal frames in the "new" cycle should also behave.
    for (let i = 0; i < 5; i += 1) {
      time += 10;
      expect(() => flushOneFrame(time)).not.toThrow();
    }

    expect(() => handle.dispose()).not.toThrow();
  });

  it("T-305: invokes onContextLost and prevents the browser default when the WebGL context is lost", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const onContextLost = vi.fn();
    const handle = createIntentRoutingGalaxy({ onContextLost });
    const container = document.createElement("div");
    handle.mount(container);

    const canvas = container.querySelector("canvas");
    if (!canvas) {
      throw new Error("expected the renderer's canvas to be attached");
    }
    const event = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(event);

    expect(onContextLost).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    handle.dispose();
  });

  it("T-305: stops reacting to context-lost events after dispose()", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const onContextLost = vi.fn();
    const handle = createIntentRoutingGalaxy({ onContextLost });
    const container = document.createElement("div");
    handle.mount(container);
    const canvas = container.querySelector("canvas");
    if (!canvas) {
      throw new Error("expected the renderer's canvas to be attached");
    }

    handle.dispose();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));

    expect(onContextLost).not.toHaveBeenCalled();
  });

  it("T-305: does not throw when the context is lost and no onContextLost callback was provided", async () => {
    const { createIntentRoutingGalaxy } = await import("./IntentRoutingGalaxy.js");
    const handle = createIntentRoutingGalaxy();
    const container = document.createElement("div");
    handle.mount(container);
    const canvas = container.querySelector("canvas");
    if (!canvas) {
      throw new Error("expected the renderer's canvas to be attached");
    }

    expect(() =>
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })),
    ).not.toThrow();

    handle.dispose();
  });
});
