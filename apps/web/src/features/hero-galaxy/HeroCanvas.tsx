import { useEffect, useRef, type CSSProperties } from "react";
import type { GalaxyHandle, GalaxyOptions } from "./scene/IntentRoutingGalaxy.js";

// Cached at module scope so the scene chunk is only ever fetched once, no
// matter how many times an effect that loads it runs (React StrictMode's
// dev-mode double-invoke, or this component remounting elsewhere on the
// page). Re-issuing `import()` per effect run is wasteful and — as
// StrictMode's rapid back-to-back calls demonstrated — can even resolve
// inconsistently; a single shared promise sidesteps both.
let scenePromise: Promise<typeof import("./scene/IntentRoutingGalaxy.js")> | null = null;
function loadSceneModule(): Promise<typeof import("./scene/IntentRoutingGalaxy.js")> {
  scenePromise ??= import("./scene/IntentRoutingGalaxy.js").catch((error: unknown) => {
    // Let a future mount attempt retry the fetch (e.g. transient network
    // failure) instead of permanently caching a rejected promise.
    scenePromise = null;
    throw error;
  });
  return scenePromise;
}

/**
 * `HeroCanvas` is thin lifecycle glue (F-303/F-304) between React and the
 * `IntentRoutingGalaxy` deep module: it dynamically imports the Three.js
 * scene module (so the chunk never blocks first paint or the page's main
 * buttons), mounts it into a plain container `<div>`, and wires
 * `IntersectionObserver` / `document.visibilitychange` to `pause()`/
 * `resume()` the render loop when the canvas leaves the viewport or the tab
 * is hidden. It owns no animation state itself — everything narrative lives
 * behind `GalaxyHandle`.
 *
 * This component does NOT decide when to show a static fallback instead of
 * the canvas (WebGL unavailable, `prefers-reduced-motion`, load failure as a
 * user-facing degrade). That decision belongs to `StaticFallback.tsx`
 * (T-305), which is expected to wrap/gate `HeroCanvas`. Here, a failed
 * dynamic import is only handled defensively: it must not throw an
 * unhandled rejection or leave listeners/observers dangling.
 */
export interface HeroCanvasProps {
  /** Forwarded as-is to `GalaxyOptions.reducedMotion`. T-305 owns detecting
   * `prefers-reduced-motion`; this component just passes the value through. */
  reducedMotion?: boolean;
  /** Forwarded as-is to `GalaxyOptions.phaseDurationMs`. */
  phaseDurationMs?: number;
  /** Optional class for the mount container (layout/sizing only). */
  className?: string;
  /**
   * Optional inline style for the mount container (layout/sizing only).
   * Codex review (P1, T-308): the container `<div>` this component renders
   * has no intrinsic height — with none supplied here, `resizeToContainer()`
   * in the deep module observes a zero-height container and clamps it to
   * 1px, rendering the production galaxy as a near-invisible sliver. This
   * project has no stylesheet/className-based styling system (every visual
   * component uses inline `style`, see `StaticFallback.tsx`), so a `style`
   * prop — not a `className` convention — is how a caller actually reserves
   * real height here.
   */
  style?: CSSProperties;
  /**
   * Invoked if the dynamic import of the scene module fails (F-305).
   * HeroCanvas itself never shows a fallback UI (see the file doc above) —
   * this is purely a signal for a wrapping component (StaticFallback,
   * T-305) to react to by switching to the static composition.
   */
  onLoadError?: () => void;
  /** Forwarded as-is to `GalaxyOptions.onContextLost` (F-305). */
  onContextLost?: () => void;
}

export function HeroCanvas({
  reducedMotion,
  phaseDurationMs,
  className,
  style,
  onLoadError,
  onContextLost,
}: HeroCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Read through refs (kept current on every render below) inside the
  // lifecycle effect, so a caller can pass new onLoadError/onContextLost
  // closures on every render without forcing the effect — whose dependency
  // array is only [reducedMotion, phaseDurationMs] — to remount the whole
  // scene just to pick up the new callback. Codex review (P2): without
  // this, the effect only ever called whichever callback identity was
  // current when it last ran, silently dropping a newly supplied one (or
  // invoking a stale one closed over an outdated value).
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;
  const onContextLostRef = useRef(onContextLost);
  onContextLostRef.current = onContextLost;

  // Single effect owns the entire mount -> observe -> dispose lifecycle so
  // there is exactly one place that can call mount()/dispose() on a given
  // GalaxyHandle — see design.md's "不在多个组件用 useEffect 互相同步动画阶段"
  // constraint. `handle`/`observer`/`cancelled` are all local to one effect
  // invocation, so React StrictMode's dev-mode double-invoke (effect ->
  // cleanup -> effect) can never leave two live handles or an unbalanced
  // mount/dispose count: the first invocation's async import resolves after
  // `cancelled` has already been set by its own cleanup, so it aborts
  // before ever calling createIntentRoutingGalaxy()/mount().
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    let handle: GalaxyHandle | null = null;
    let observer: IntersectionObserver | null = null;

    const options: GalaxyOptions = {
      reducedMotion,
      phaseDurationMs,
      onContextLost: () => onContextLostRef.current?.(),
    };

    // Two independent sources can each demand a pause: the tab being
    // hidden, and the container scrolling out of the viewport. Codex review
    // (P2): treating them as independent pause()/resume() triggers let
    // either source's "resume" override the other source's "pause" — e.g.
    // the tab becomes visible again while the canvas is still offscreen,
    // and the visibilitychange handler alone would incorrectly resume it.
    // Track both conditions and only resume when both agree the canvas
    // should be running; pause whenever either says it shouldn't.
    let isDocumentVisible = !document.hidden;
    let isIntersecting = false;

    function syncRunningState(): void {
      if (!handle) {
        return;
      }
      if (isDocumentVisible && isIntersecting) {
        handle.resume();
      } else {
        handle.pause();
      }
    }

    const handleVisibilityChange = () => {
      isDocumentVisible = !document.hidden;
      syncRunningState();
    };

    loadSceneModule()
      .then(({ createIntentRoutingGalaxy }) => {
        // Guards the race where the dynamic import resolves after this
        // component (or this effect invocation) has already unmounted /
        // been cleaned up — without this, mount() could fire on a
        // detached container and dispose() would never balance it.
        if (cancelled) {
          return;
        }

        handle = createIntentRoutingGalaxy(options);
        handle.mount(container);
        // mount() starts the render loop unconditionally; immediately
        // reconcile it against the actual current visibility/intersection
        // state (mounting while the tab is already hidden must not leave
        // the loop running until the next visibilitychange/intersection
        // event fires).
        syncRunningState();

        observer = new IntersectionObserver((entries) => {
          const entry = entries[0];
          if (!entry) {
            return;
          }
          isIntersecting = entry.isIntersecting;
          syncRunningState();
        });
        observer.observe(container);

        document.addEventListener("visibilitychange", handleVisibilityChange);
      })
      .catch(() => {
        // Chunk failed to load (network error, etc). T-305 decides whether
        // to render StaticFallback instead; T-304's contract is just to not
        // throw and to leave no partially-created resources behind. Guard
        // with `cancelled` for the same reason as the `.then()` branch: a
        // late rejection after unmount must not reach a since-unmounted
        // wrapper's state setter.
        if (!cancelled) {
          onLoadErrorRef.current?.();
        }
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // `handle` is only non-null once mount() has already been called on
      // it, so this dispose() is always exactly-once-per-mounted-handle.
      handle?.dispose();
      handle = null;
    };
  }, [reducedMotion, phaseDurationMs]);

  return <div ref={containerRef} className={className} style={style} />;
}
