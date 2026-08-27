import { useEffect, useState, type ReactNode } from "react";
import { HeroCanvas } from "./HeroCanvas.js";
import { HERO_GALAXY_PALETTE } from "./scene/palette.js";
import { useReducedMotion } from "./useReducedMotion.js";
import { useWebglSupport } from "./useWebglSupport.js";

/**
 * `StaticFallback` is the gate HeroCanvas's own file doc anticipates
 * (T-304: "That decision belongs to StaticFallback.tsx (T-305), which is
 * expected to wrap/gate HeroCanvas"). Consumers render only `StaticFallback`
 * — never `HeroCanvas` directly — mirroring the same "hide the dynamic
 * detail behind a simple contract" spirit as `IntentRoutingGalaxy` hiding
 * Three.js behind `HeroCanvas` (F-303).
 *
 * It switches to the static composition (F-305/F-306) when ANY of these
 * hold: WebGL is unsupported, `prefers-reduced-motion` is on, the scene
 * chunk failed to load, or the WebGL context was lost after mount. Per
 * design.md's explicit anti-fragmentation rule ("静态降级路径必须与动态路径
 * 共用同一份内容语义"), the static composition below depicts the SAME
 * content — task core, three candidate slots (two TOP_SCORE + one
 * EXPLORATION), the staking ring, and the settlement state — as one
 * flattened snapshot, using the same `HERO_GALAXY_PALETTE` semantic colors
 * as the live scene, rather than a different, drifting illustration.
 *
 * Design choice, two options compared:
 * - Chosen: `prefers-reduced-motion` renders this SAME static composition
 *   (F-306's "静态构图" branch), rather than mounting the live WebGL scene
 *   with slowed phase durations (F-306's "低频淡入" branch). The
 *   low-frequency-fade alternative would require adding motion-pacing
 *   logic inside `IntentRoutingGalaxy.ts` — a deep module whose T-301/T-303
 *   lineages are already reviewed and closed — for a purely cosmetic
 *   difference between two requirements-approved options. Reusing the
 *   static path keeps this Task's diff scoped to its own new files and
 *   avoids reopening an already-ALLOW'd module for no functional gain.
 */
export interface StaticFallbackProps {
  /** Forwarded to HeroCanvas when the dynamic scene is actually mounted. */
  phaseDurationMs?: number;
  /** Optional class for the outer section element. */
  className?: string;
  /**
   * Rendered above the canvas/static area in normal DOM flow — the
   * headline/CTA slot a consuming page composes here (AC-302: "标题/说明/
   * 主要操作保持普通 DOM 安全区，不被 Canvas 遮挡"). Both the static and
   * dynamic branches reserve the same layout region for the visual so a
   * consumer's CTA placement doesn't depend on which branch is active.
   */
  children?: ReactNode;
}

const MOBILE_VIEWPORT_QUERY = "(max-width: 640px)";

function readIsMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
}

/**
 * Local, non-exported hook: no separate file per design.md's file list,
 * which only names `useReducedMotion`/`useWebglSupport` as siblings. Same
 * matchMedia-plus-`change`-listener shape as `useReducedMotion` — a device
 * rotation or window resize across the breakpoint must update the density
 * live, not just on first mount.
 */
function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(readIsMobileViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQueryList = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const handleChange = () => setIsMobile(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}

/**
 * Reserved visual height for whichever branch is active (Codex review, P1,
 * T-308): `HeroCanvas`'s container `<div>` has no intrinsic height of its
 * own, so without an explicit height the dynamic WebGL path collapses to a
 * near-invisible 1px canvas (`resizeToContainer()` clamps zero-height to
 * 1px). Applying the SAME value to both branches also keeps the reserved
 * area's size consistent when switching between them (load failure/context
 * loss mid-session), avoiding a layout shift.
 */
const HERO_VISUAL_MIN_HEIGHT = "420px";

function toCssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

interface CandidateSlotProps {
  label: string;
  color: string;
  dashed?: boolean;
}

function CandidateSlot({ label, color, dashed }: CandidateSlotProps) {
  return (
    <div
      data-static-fallback-candidate={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        border: `2px ${dashed ? "dashed" : "solid"} ${color}`,
        borderRadius: "9999px",
        padding: "0.25rem 0.75rem",
        color,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "0.5rem",
          height: "0.5rem",
          borderRadius: "9999px",
          background: color,
        }}
      />
      {label}
    </div>
  );
}

interface StaticCompositionProps {
  variant: "desktop" | "mobile";
}

/**
 * The actual static graphic (F-305/F-306). Exported separately so it is
 * unit-testable without needing to force any of the gate's WebGL/
 * reduced-motion conditions.
 */
export function StaticComposition({ variant }: StaticCompositionProps) {
  const isMobile = variant === "mobile";
  return (
    <div
      data-static-fallback-composition={variant}
      role="img"
      aria-label="意图路由星图静态展示：任务发布、智能撮合、候选质押与链上结算的产品机制演示"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: isMobile ? "0.75rem" : "1.25rem",
        padding: isMobile ? "1.5rem" : "2.5rem",
        // AC-302/AC-304: this element only ever fills ITS OWN reserved
        // area — it never uses fixed/viewport-relative positioning that
        // could escape a consuming page's layout and cover nav/CTA
        // elements placed elsewhere in normal flow.
        width: "100%",
        minHeight: HERO_VISUAL_MIN_HEIGHT,
        boxSizing: "border-box",
      }}
    >
      <div
        data-static-fallback-task-core
        style={{
          width: isMobile ? "3rem" : "4rem",
          height: isMobile ? "3rem" : "4rem",
          borderRadius: "9999px",
          border: `3px solid ${toCssColor(HERO_GALAXY_PALETTE.cyberBlue)}`,
        }}
        aria-hidden="true"
      />

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0.5rem",
        }}
      >
        <CandidateSlot
          label="候选 A · 高分"
          color={toCssColor(HERO_GALAXY_PALETTE.amethystPurple)}
        />
        <CandidateSlot
          label="候选 B · 高分"
          color={toCssColor(HERO_GALAXY_PALETTE.amethystPurple)}
        />
        {/* Codex review (P2): an earlier version dropped this slot entirely
            on mobile, but F-307/requirements.md is explicit that mobile
            must "保留任务核心和三个推荐槽位的语义" — THREE slots, not two.
            At this badge/label level there is no real density cost to
            keeping all three (unlike the live WebGL scene's node/connection
            count, which this composition doesn't render at all), so mobile
            density is expressed elsewhere (smaller task core, tighter
            gap/padding — see the `isMobile` styling above) rather than by
            removing a required semantic element. */}
        <CandidateSlot
          label="候选 C · 新人探索"
          color={toCssColor(HERO_GALAXY_PALETTE.explorationPurple)}
          dashed
        />
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0.5rem",
        }}
      >
        <span
          data-static-fallback-staking-ring
          style={{
            border: `2px solid ${toCssColor(HERO_GALAXY_PALETTE.stakingOrange)}`,
            borderRadius: "9999px",
            padding: "0.25rem 0.75rem",
            color: toCssColor(HERO_GALAXY_PALETTE.stakingOrange),
          }}
        >
          接单质押 6%
        </span>
        <span
          data-static-fallback-settlement
          style={{
            border: `2px solid ${toCssColor(HERO_GALAXY_PALETTE.settlementGreen)}`,
            borderRadius: "9999px",
            padding: "0.25rem 0.75rem",
            color: toCssColor(HERO_GALAXY_PALETTE.settlementGreen),
          }}
        >
          链上结算完成
        </span>
      </div>

      {/* AC-306: demo data must never read as a real mainnet metric. */}
      <p
        style={{
          fontSize: "0.75rem",
          color: toCssColor(HERO_GALAXY_PALETTE.disqualifiedGray),
          margin: 0,
        }}
      >
        产品机制演示 · 示例数据，非真实链上指标
      </p>
    </div>
  );
}

/**
 * The smart gate: decides static-vs-dynamic and owns the load-error /
 * context-lost signals HeroCanvas/IntentRoutingGalaxy forward up to it.
 */
export function StaticFallback({ phaseDurationMs, className, children }: StaticFallbackProps) {
  const webglSupported = useWebglSupport();
  const prefersReducedMotion = useReducedMotion();
  const isMobile = useIsMobileViewport();
  const [loadFailed, setLoadFailed] = useState(false);
  const [contextLost, setContextLost] = useState(false);

  const showStatic = !webglSupported || prefersReducedMotion || loadFailed || contextLost;

  return (
    <section
      data-hero-static-fallback-gate={showStatic ? "static" : "dynamic"}
      className={className}
      style={{ position: "relative", width: "100%" }}
    >
      {children}
      {showStatic ? (
        <StaticComposition variant={isMobile ? "mobile" : "desktop"} />
      ) : (
        <HeroCanvas
          phaseDurationMs={phaseDurationMs}
          style={{ width: "100%", minHeight: HERO_VISUAL_MIN_HEIGHT }}
          onLoadError={() => setLoadFailed(true)}
          onContextLost={() => setContextLost(true)}
        />
      )}
    </section>
  );
}
