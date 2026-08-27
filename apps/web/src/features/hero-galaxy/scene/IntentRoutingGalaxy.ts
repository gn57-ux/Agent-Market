import * as THREE from "three";
import { NARRATIVE_PHASES, NarrativePhaseClock, type NarrativePhase } from "./narrativePhase.js";
import { HERO_GALAXY_PALETTE } from "./palette.js";
import {
  computeAgentRingPositions,
  DEFAULT_AGENT_NODE_COUNT,
  DEFAULT_AGENT_RING_RADIUS,
  type AgentNodePosition,
} from "./nodes/agentNodeLayout.js";
import { createAgentNodeNetwork } from "./nodes/agentNodes.js";
import {
  selectAcceptedCandidate,
  selectCandidates,
  type CandidateSelection,
} from "./nodes/candidateSelection.js";
import { createConnectionLines } from "./nodes/connectionLines.js";
import { createDeliveryParticle } from "./nodes/deliveryParticle.js";
import { isAgentQualified } from "./nodes/matchingQualification.js";
import { createScanWave } from "./nodes/scanWave.js";
import { createStakingRing } from "./nodes/stakingRing.js";
import { createTaskCore } from "./nodes/taskCore.js";

/**
 * Maximum device pixel ratio the renderer will use. Capped per the
 * non-functional requirement in requirements.md ("渲染像素比默认最高不超过
 * 1.5") to bound GPU/fill-rate cost on high-DPI screens.
 */
const MAX_PIXEL_RATIO = 1.5;

export interface GalaxyOptions {
  /**
   * When true, the galaxy should minimize/soften motion. T-301 only wires
   * the option through as a typed extension point — actually honoring it
   * (holding a static composition, slow fades, etc.) is T-305's job.
   */
  reducedMotion?: boolean;
  /** Duration in ms each narrative phase is held before advancing. */
  phaseDurationMs?: number;
  /**
   * Invoked once if the WebGL context is lost after mount (F-305, "上下文
   * 丢失...自动切换静态背景"). This module does not attempt context
   * restoration itself — PRD §10.1 treats context loss the same as "WebGL
   * 不可用": fall back to the static composition, don't try to recover a
   * live animation mid-cycle. The caller (StaticFallback, T-305) is
   * expected to react by disposing this handle and switching to static.
   */
  onContextLost?: () => void;
}

export interface GalaxyHandle {
  mount(container: HTMLElement): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

/**
 * `IntentRoutingGalaxy` is the deep module (F-303) behind the Hero Canvas:
 * it owns the Three.js scene, camera, renderer, render loop, and the
 * narrative phase state machine driving it. Callers (HeroCanvas.tsx) only
 * ever see `mount/pause/resume/dispose` — no Three.js object, RAF handle,
 * or phase state leaks across the boundary.
 *
 * Visibility-driven pausing (IntersectionObserver / visibilitychange) is
 * intentionally NOT wired up here — that orchestration belongs to
 * HeroCanvas (T-304). This module only exposes `pause()`/`resume()` as
 * plain callable methods.
 */
export function createIntentRoutingGalaxy(options: GalaxyOptions = {}): GalaxyHandle {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 8);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));

  // Attached directly to the canvas element (works even before it's
  // attached to the DOM in mount()), so cleanup in dispose() is
  // deterministic regardless of whether mount() was ever called.
  function handleContextLost(event: Event): void {
    // Prevent the browser's default (which otherwise just leaves the
    // canvas blank with no restore attempt) — the caller switches to the
    // static composition instead; see `onContextLost`'s doc.
    event.preventDefault();
    options.onContextLost?.();
  }
  renderer.domElement.addEventListener("webglcontextlost", handleContextLost);

  const phaseClock = new NarrativePhaseClock({ phaseDurationMs: options.phaseDurationMs });
  // Scan-wave sweep and MATCHING's per-node reveal read `phaseClock.progress`
  // directly (not the raw `options.phaseDurationMs`): the clock normalizes
  // invalid durations (0/negative/NaN/Infinity/too-small) to its own
  // default, and using the raw option here would desync from that,
  // producing NaN/negative/always-saturated progress for those inputs.

  // Whether this cycle's MATCHING qualification result has been computed
  // and applied to the node network/connections. A very large frame delta
  // (e.g. the tab was backgrounded) can make `phaseClock.tick()` advance
  // straight past MATCHING in one step; without this flag, phases after
  // MATCHING would render with the node network stuck at whatever it was
  // *before* MATCHING ran (never marked qualified/disqualified/connected).
  let matchingSettled = false;

  // Task core, Agent node network, connection lines, and the MATCHING scan
  // wave (T-302 / F-302, PRD §10.1 core narrative + visual-semantic table).
  // Node positions are computed once and shared between the node network
  // and its connection lines so both stay geometrically consistent.
  const agentPositions = computeAgentRingPositions({
    count: DEFAULT_AGENT_NODE_COUNT,
    radius: DEFAULT_AGENT_RING_RADIUS,
  });
  const taskCore = createTaskCore();
  const agentNodeNetwork = createAgentNodeNetwork(
    DEFAULT_AGENT_NODE_COUNT,
    DEFAULT_AGENT_RING_RADIUS,
  );
  const connectionLines = createConnectionLines(agentPositions);
  const scanWave = createScanWave();
  // T-303 (F-303 narrative stages 4–6): staking ring (STAKE_LOCKED onward)
  // and the single delivery particle (EXECUTING/RESULT_RETURNED). Added to
  // `scene` directly (not nested in an existing group) so `dispose()`'s
  // generic `scene.traverse` cleanup — which already handles any
  // THREE.Mesh/Line/Points — covers them without further changes.
  const stakingRing = createStakingRing();
  const deliveryParticle = createDeliveryParticle();
  scene.add(
    taskCore.mesh,
    agentNodeNetwork.group,
    connectionLines.group,
    scanWave.mesh,
    stakingRing.mesh,
    deliveryParticle.mesh,
  );

  /** Test-only-style safe index helper: `noUncheckedIndexedAccess` types array indexing as possibly `undefined`. `agentPositions`/`agentNodeNetwork.nodes` are always exactly `DEFAULT_AGENT_NODE_COUNT` long and every index this module derives (`candidateSelection`'s outputs) is always in `[0, DEFAULT_AGENT_NODE_COUNT)` by construction (see `selectCandidates`), so this can only fail on a real invariant violation — in which case falling back to the ring's first position keeps the render loop from throwing rather than crashing the animation over a visual-only lookup. */
  function agentPositionAt(index: number): AgentNodePosition {
    const position = agentPositions[index];
    if (position) {
      return position;
    }
    const fallback = agentPositions[0];
    if (fallback) {
      return fallback;
    }
    return { index: 0, x: 0, y: 0, z: 0 };
  }

  /**
   * Slow "breathing" period (ms) for the staking ring's pulse, driven by
   * `activeElapsedMs` (see `applyPhaseVisuals`'s param doc) — not the raw
   * RAF timestamp — so the pulse doesn't jump on `resume()` after a
   * `pause()`, matching `taskCore`'s own pulse.
   */
  const STAKING_RING_PULSE_PERIOD_MS = 3000;

  // The CANDIDATES_SELECTED/accepted-candidate selection for the current
  // narrative cycle. Computed once (`ensureCandidatesComputed`) the first
  // time it's needed each cycle and held stable through STAKE_LOCKED,
  // EXECUTING, RESULT_RETURNED, and SETTLED — "who is TOP_SCORE/EXPLORATION/
  // accepted" must not change mid-cycle. Reset to null on the SETTLED ->
  // IDLE wraparound (see the IDLE branch below) so the next cycle re-rolls
  // it (deterministically, since `selectCandidates`/`isAgentQualified` are
  // pure functions of node index — but re-computed per cycle for clarity
  // and to mirror `matchingSettled`'s reset pattern).
  let currentCandidates: CandidateSelection | null = null;
  let acceptedCandidateIndex: number | null = null;

  /**
   * Resets every piece of per-cycle state T-303 introduced back to its
   * pre-cycle baseline: no candidate/accepted selection, task core back to
   * Cyber Blue, staking ring and delivery particle hidden, and MATCHING's
   * settle-guard re-armed. Called from the IDLE branch above, and also from
   * `renderFrame`'s explicit wraparound guard below — the latter exists
   * because `NarrativePhaseClock` only exposes the *final* phase reached
   * after `tick()`, so a large enough delta can jump straight from SETTLED
   * to INTENT_CREATED (or further) without the phase ever equaling "IDLE"
   * on any single frame, which would otherwise leave the task core green
   * and the accepted node/connection in their SETTLED look for the entire
   * next cycle (Codex review, P2).
   */
  function resetCycleState(): void {
    matchingSettled = false;
    currentCandidates = null;
    acceptedCandidateIndex = null;
    taskCore.setColor(HERO_GALAXY_PALETTE.cyberBlue);
    stakingRing.mesh.visible = false;
    deliveryParticle.mesh.visible = false;
  }

  /**
   * Ensures `currentCandidates`/`acceptedCandidateIndex` are populated for
   * the current cycle, computing them on first use. This has no timing
   * dependency (unlike `applyMatchingQualification`, which reads
   * `phaseClock.progress`) — `selectCandidates`/`selectAcceptedCandidate`
   * are pure functions of node index — so, unlike MATCHING's scan-sweep
   * reveal, there is no "huge frame delta skipped the reveal" risk to guard
   * against here: whichever frame first reaches CANDIDATES_SELECTED (or
   * later) computes the *same* deterministic result a normal frame would
   * have. This still needs to run before any CANDIDATES_SELECTED..SETTLED
   * visual applies, mirroring the `matchingSettled` guard's placement.
   */
  function ensureCandidatesComputed(): { candidates: CandidateSelection; acceptedIndex: number } {
    if (currentCandidates === null || acceptedCandidateIndex === null) {
      currentCandidates = selectCandidates(DEFAULT_AGENT_NODE_COUNT);
      acceptedCandidateIndex = selectAcceptedCandidate(currentCandidates);
    }
    return { candidates: currentCandidates, acceptedIndex: acceptedCandidateIndex };
  }

  /**
   * Fraction of the MATCHING phase's dwell time at which node `index`
   * "activates" (the scan wave reaches it) — staggered by ring position so
   * the sweep reads as sequential rather than every node flipping at once.
   */
  function scanActivationThreshold(index: number): number {
    return 0.15 + (index / DEFAULT_AGENT_NODE_COUNT) * 0.7;
  }

  /**
   * Applies node/connection state for a given MATCHING progress in [0, 1].
   * Factored out so it can be invoked both from the normal per-frame
   * MATCHING path and from the "settle deterministically" fallback below
   * (called with progress=1) when a delayed frame skips past MATCHING
   * entirely.
   */
  function applyMatchingQualification(progress: number): void {
    for (let index = 0; index < DEFAULT_AGENT_NODE_COUNT; index += 1) {
      if (progress >= scanActivationThreshold(index)) {
        const qualified = isAgentQualified(index);
        agentNodeNetwork.setState(index, qualified ? "eligible" : "disqualified");
        connectionLines.setConnection(index, qualified ? "solid" : "hidden");
      } else {
        agentNodeNetwork.setState(index, "idle");
        connectionLines.setConnection(index, "hidden");
      }
    }
  }

  /**
   * Narrative stage 3 ("候选形成", PRD §10.1): exactly three Agent nodes
   * highlighted — two TOP_SCORE, one EXPLORATION — everything else that
   * MATCHING qualified falls back to a non-highlighted "disqualified" look
   * (only the three candidates keep the spotlight past this point).
   */
  function applyCandidatesSelectedVisuals(candidates: CandidateSelection): void {
    const [topScoreA, topScoreB] = candidates.topScore;
    for (let index = 0; index < DEFAULT_AGENT_NODE_COUNT; index += 1) {
      if (index === topScoreA || index === topScoreB) {
        agentNodeNetwork.setState(index, "topScore");
        connectionLines.setConnection(index, "solid");
      } else if (index === candidates.exploration) {
        agentNodeNetwork.setState(index, "exploration");
        connectionLines.setConnection(index, "exploration");
      } else {
        agentNodeNetwork.setState(index, "disqualified");
        connectionLines.setConnection(index, "hidden");
      }
    }
  }

  /**
   * Narrative stage 4 ("接单质押"): the accepted candidate gets the Orange
   * staking ring + an "accepted" connection; the other two candidates
   * "退出当前任务轨道" — drop back to the same non-highlighted look as any
   * other non-candidate node.
   */
  function applyStakeLockedVisuals(acceptedIndex: number, activeElapsedMs: number): void {
    for (let index = 0; index < DEFAULT_AGENT_NODE_COUNT; index += 1) {
      if (index === acceptedIndex) {
        agentNodeNetwork.setState(index, "accepted");
        connectionLines.setConnection(index, "accepted");
      } else {
        agentNodeNetwork.setState(index, "disqualified");
        connectionLines.setConnection(index, "hidden");
      }
    }

    stakingRing.mesh.visible = true;
    const pulseProgress =
      (activeElapsedMs % STAKING_RING_PULSE_PERIOD_MS) / STAKING_RING_PULSE_PERIOD_MS;
    stakingRing.update(pulseProgress, agentPositionAt(acceptedIndex));
  }

  /**
   * Narrative stage 5 ("执行交付"): task data flows out along the accepted
   * connection during EXECUTING (task core -> Agent, Cyber Blue), then the
   * result flows back during RESULT_RETURNED (Agent -> task core, Emerald
   * Green — see `deliveryParticle.ts`'s module doc for why green starts
   * here rather than only at SETTLED). The accepted node/connection/staking
   * ring hold their STAKE_LOCKED appearance throughout both phases — only
   * the delivery particle is phase-specific.
   */
  function applyDeliveryVisuals(
    phase: "EXECUTING" | "RESULT_RETURNED",
    acceptedIndex: number,
    activeElapsedMs: number,
  ): void {
    applyStakeLockedVisuals(acceptedIndex, activeElapsedMs);

    const origin = { x: 0, y: 0, z: 0 };
    const acceptedPosition = agentPositionAt(acceptedIndex);
    const progress = phaseClock.progress;

    deliveryParticle.mesh.visible = true;
    if (phase === "EXECUTING") {
      deliveryParticle.update(progress, origin, acceptedPosition, HERO_GALAXY_PALETTE.cyberBlue);
    } else {
      deliveryParticle.update(
        progress,
        acceptedPosition,
        origin,
        HERO_GALAXY_PALETTE.settlementGreen,
      );
    }
  }

  /**
   * Narrative stage 6 ("链上结算"): task core becomes the "可验证区块" and
   * turns Emerald Green, the accepted node/connection turn green too
   * ("托管预算流向 Agent"). The staking ring is hidden here — its job (
   * "质押已锁定") is done once settlement completes, so holding it visible
   * would read as a stale/unresolved stake rather than a completed one.
   */
  function applySettledVisuals(acceptedIndex: number): void {
    taskCore.setColor(HERO_GALAXY_PALETTE.settlementGreen);
    agentNodeNetwork.setState(acceptedIndex, "settled");
    connectionLines.setConnection(acceptedIndex, "settled");
    for (let index = 0; index < DEFAULT_AGENT_NODE_COUNT; index += 1) {
      if (index !== acceptedIndex) {
        agentNodeNetwork.setState(index, "disqualified");
        connectionLines.setConnection(index, "hidden");
      }
    }

    stakingRing.mesh.visible = false;
    deliveryParticle.mesh.visible = false;
  }

  /**
   * Applies the current narrative phase's visual state to the task core,
   * Agent node network, connections, scan wave, staking ring, and delivery
   * particle.
   *
   * @param activeElapsedMs Total animation time (ms) while running,
   *   excluding any paused interval — NOT the raw RAF timestamp. Passing
   *   the raw timestamp made the task core's pulse/rotation jump by the
   *   entire wall-clock pause duration on resume(), even though the
   *   narrative phase clock itself deliberately excludes paused time.
   */
  function applyPhaseVisuals(phase: NarrativePhase, activeElapsedMs: number): void {
    taskCore.update(activeElapsedMs);
    // IDLE has no active task yet ("恢复 Agent 网络环境状态，等待下一轮任务
    // 意图", PRD §10.1 stage 7); every later phase shows the task core.
    taskCore.mesh.visible = phase !== "IDLE";

    if (phase === "MATCHING") {
      const progress = phaseClock.progress;
      scanWave.mesh.visible = true;
      scanWave.update(progress, DEFAULT_AGENT_RING_RADIUS);
      applyMatchingQualification(progress);
      matchingSettled = progress >= 1;
      stakingRing.mesh.visible = false;
      deliveryParticle.mesh.visible = false;
      return;
    }

    scanWave.mesh.visible = false;
    scanWave.update(0, DEFAULT_AGENT_RING_RADIUS);

    if (phase === "IDLE") {
      agentNodeNetwork.setAllStates("idle");
      connectionLines.setAllConnections("hidden");
      // Settlement scene fades, network returns to its ambient idle state
      // (PRD §10.1 stage 7 "自然循环"). The per-cycle state itself
      // (candidate/accepted selection, task core color, staking
      // ring/particle visibility) is reset by `resetCycleState()`, called
      // both here and — critically — from the wraparound guard in
      // `renderFrame` below, which also handles the case where a delayed
      // frame's delta skips past IDLE entirely (SETTLED -> ... ->
      // INTENT_CREATED in one tick) without this branch ever running.
      resetCycleState();
      return;
    }

    // INTENT_CREATED holds the idle network state (task core just
    // appeared) and none of T-303's later-phase visuals apply yet.
    if (phase === "INTENT_CREATED") {
      stakingRing.mesh.visible = false;
      deliveryParticle.mesh.visible = false;
      return;
    }

    // CANDIDATES_SELECTED..SETTLED hold MATCHING's last qualification
    // result — unless a delayed frame skipped straight past MATCHING
    // without ever running it (matchingSettled still false), in which case
    // settle the qualification result deterministically now rather than
    // leaving the network stuck at its pre-MATCHING state for the rest of
    // the cycle.
    if (!matchingSettled) {
      applyMatchingQualification(1);
      matchingSettled = true;
    }

    const { candidates, acceptedIndex } = ensureCandidatesComputed();

    switch (phase) {
      case "CANDIDATES_SELECTED":
        applyCandidatesSelectedVisuals(candidates);
        stakingRing.mesh.visible = false;
        deliveryParticle.mesh.visible = false;
        break;
      case "STAKE_LOCKED":
        applyStakeLockedVisuals(acceptedIndex, activeElapsedMs);
        deliveryParticle.mesh.visible = false;
        break;
      case "EXECUTING":
      case "RESULT_RETURNED":
        applyDeliveryVisuals(phase, acceptedIndex, activeElapsedMs);
        break;
      case "SETTLED":
        applySettledVisuals(acceptedIndex);
        break;
      default: {
        // Exhaustiveness check: IDLE/INTENT_CREATED/MATCHING already
        // returned above, so only CANDIDATES_SELECTED..SETTLED reach here.
        const exhaustiveCheck: never = phase;
        return exhaustiveCheck;
      }
    }
  }

  let container: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rafHandle: number | null = null;
  let lastFrameTime: number | null = null;
  let activeElapsedMs = 0;
  let running = false;
  // Tracks the phase as of the end of the previous frame, so `renderFrame`
  // can detect an IDLE-crossing cycle wraparound even when a single tick's
  // delta is large enough that the phase never literally equals "IDLE" on
  // any observed frame (see `resetCycleState`'s doc).
  let previousPhaseIndex = NARRATIVE_PHASES.indexOf(phaseClock.phase);

  function resizeToContainer(): void {
    if (!container) {
      return;
    }
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    // Let Three.js write CSS width/height on the canvas (updateStyle=true,
    // the default). Passing `false` here left the canvas's backing store
    // sized to width*pixelRatio while its CSS box stayed unset, so at
    // devicePixelRatio > 1 the canvas visually overflowed its container.
    renderer.setSize(width, height, true);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function renderFrame(now: number): void {
    if (!running) {
      return;
    }
    const delta = lastFrameTime === null ? 0 : now - lastFrameTime;
    lastFrameTime = now;
    activeElapsedMs += delta;

    const transitions = phaseClock.tick(delta);
    const currentPhaseIndex = NARRATIVE_PHASES.indexOf(phaseClock.phase);
    // A wraparound (IDLE was crossed at least once) happened if any
    // transitions occurred and either the phase index went "backwards"
    // (the normal single-wrap case: e.g. SETTLED index 7 -> INTENT_CREATED
    // index 1) or `transitions` alone is at least a full cycle long (the
    // pathological case where the index lands back at/after its previous
    // value purely because a whole number of full cycles elapsed in one
    // tick, which a plain index comparison alone would miss).
    if (
      transitions > 0 &&
      (currentPhaseIndex < previousPhaseIndex || transitions >= NARRATIVE_PHASES.length)
    ) {
      resetCycleState();
    }
    previousPhaseIndex = currentPhaseIndex;

    applyPhaseVisuals(phaseClock.phase, activeElapsedMs);

    renderer.render(scene, camera);
    rafHandle = window.requestAnimationFrame(renderFrame);
  }

  function startLoop(): void {
    if (running) {
      return;
    }
    running = true;
    lastFrameTime = null;
    rafHandle = window.requestAnimationFrame(renderFrame);
  }

  function stopLoop(): void {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function mount(target: HTMLElement): void {
    if (container) {
      throw new Error("IntentRoutingGalaxy: already mounted; call dispose() before remounting.");
    }
    container = target;
    container.appendChild(renderer.domElement);
    resizeToContainer();

    resizeObserver = new ResizeObserver(() => resizeToContainer());
    resizeObserver.observe(container);

    startLoop();
  }

  function pause(): void {
    stopLoop();
  }

  function resume(): void {
    if (!container) {
      return;
    }
    startLoop();
  }

  function dispose(): void {
    stopLoop();
    renderer.domElement.removeEventListener("webglcontextlost", handleContextLost);

    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    if (container && renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
    container = null;

    scene.traverse((object: THREE.Object3D) => {
      // T-302 introduced THREE.Line objects (connection lines) and a
      // THREE.Mesh-based scan wave/task core/agent nodes alongside T-301's
      // generic Mesh cleanup. THREE.Line (and THREE.LineSegments/Points,
      // for future object types) share the same
      // `geometry`/`material` shape as Mesh but are not `instanceof
      // THREE.Mesh`, so they need their own branch here — otherwise their
      // geometries/materials would silently leak on dispose().
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.Line ||
        object instanceof THREE.Points
      ) {
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) {
          material.forEach((m) => m.dispose());
        } else {
          material.dispose();
        }
      }
    });

    renderer.dispose();
  }

  return { mount, pause, resume, dispose };
}
