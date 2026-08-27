/**
 * Narrative phase state machine for the "Intent Routing Galaxy" hero
 * animation (F-301). Pure, framework-free, and fully typed — no `any`.
 *
 * Phases represent the product's core loop (PRD §10.1):
 *   发布任务 -> 智能撮合 -> 接单质押 -> 执行交付 -> 链上结算 -> (loop)
 *
 * This module owns exactly one piece of design knowledge: the phase order
 * and the wraparound rule. `IntentRoutingGalaxy.ts` drives this machine on
 * a timer inside its render loop; it must never re-derive or duplicate the
 * ordering itself (see project rule: 设计知识只能有一个归属).
 */

/** The eight narrative phases, in their canonical cycle order. */
export const NARRATIVE_PHASES = [
  "IDLE",
  "INTENT_CREATED",
  "MATCHING",
  "CANDIDATES_SELECTED",
  "STAKE_LOCKED",
  "EXECUTING",
  "RESULT_RETURNED",
  "SETTLED",
] as const;

export type NarrativePhase = (typeof NARRATIVE_PHASES)[number];

/**
 * Pure transition function: given the current phase, returns the next
 * phase in the cycle. SETTLED wraps back to IDLE, closing the loop
 * (F-301 / AC-301).
 */
export function nextPhase(current: NarrativePhase): NarrativePhase {
  switch (current) {
    case "IDLE":
      return "INTENT_CREATED";
    case "INTENT_CREATED":
      return "MATCHING";
    case "MATCHING":
      return "CANDIDATES_SELECTED";
    case "CANDIDATES_SELECTED":
      return "STAKE_LOCKED";
    case "STAKE_LOCKED":
      return "EXECUTING";
    case "EXECUTING":
      return "RESULT_RETURNED";
    case "RESULT_RETURNED":
      return "SETTLED";
    case "SETTLED":
      return "IDLE";
    default: {
      // Exhaustiveness check: if a new phase is ever added to
      // NARRATIVE_PHASES without a case above, this fails to compile.
      const exhaustiveCheck: never = current;
      return exhaustiveCheck;
    }
  }
}

/**
 * Default dwell duration (ms) per phase before advancing. Kept here so the
 * state machine and its pacing stay a single source of truth; callers may
 * override per-instance via `NarrativePhaseClock` options.
 */
export const DEFAULT_PHASE_DURATION_MS = 2000;

export interface NarrativePhaseClockOptions {
  /** Duration in ms each phase is held before advancing. */
  phaseDurationMs?: number;
  /** Phase to start from. Defaults to "IDLE". */
  initialPhase?: NarrativePhase;
}

/**
 * Smallest phase duration accepted. Below this, floating-point subtraction
 * against a typical per-frame delta (~16ms) can fail to actually reduce
 * `elapsedInPhaseMs` (e.g. a duration like `1e-300`), and even when it does
 * reduce correctly, a legitimate-looking sub-millisecond duration produces
 * an unbounded number of phase transitions per tick. 1ms is well below any
 * duration this hero animation would realistically use (the default is
 * 2000ms) but high enough to keep transitions-per-tick bounded and finite.
 */
const MIN_PHASE_DURATION_MS = 1;

/**
 * Normalizes a caller-supplied `phaseDurationMs`: falls back to
 * `DEFAULT_PHASE_DURATION_MS` for anything that is not a finite number of
 * at least `MIN_PHASE_DURATION_MS`. Without this guard, `NarrativePhaseClock
 * .tick()` could spin/iterate unboundedly on `0`/negative/too-small
 * durations, or never advance on `NaN`/`Infinity` — silently freezing or
 * stalling the render loop that drives it.
 */
function normalizePhaseDurationMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < MIN_PHASE_DURATION_MS) {
    return DEFAULT_PHASE_DURATION_MS;
  }
  return value;
}

/**
 * A small, pure, time-driven wrapper around `nextPhase`: accumulates
 * elapsed time via `tick(deltaMs)` and advances phase(s) once enough time
 * has passed. Framework-free — no RAF, no DOM — so it is trivially unit
 * testable and reusable outside of `IntentRoutingGalaxy`.
 */
export class NarrativePhaseClock {
  private readonly phaseDurationMs: number;
  private currentPhase: NarrativePhase;
  private elapsedInPhaseMs = 0;

  constructor(options: NarrativePhaseClockOptions = {}) {
    this.phaseDurationMs = normalizePhaseDurationMs(options.phaseDurationMs);
    this.currentPhase = options.initialPhase ?? "IDLE";
  }

  get phase(): NarrativePhase {
    return this.currentPhase;
  }

  /**
   * The normalized duration (ms) this clock actually uses for every phase.
   * Callers that need to compute their own progress-within-phase visuals
   * (e.g. IntentRoutingGalaxy's scan wave) must read this rather than
   * re-deriving it from the raw constructor option — the raw
   * `phaseDurationMs` option may be `0`/negative/`NaN`/too small, in which
   * case this clock silently falls back to `DEFAULT_PHASE_DURATION_MS`
   * (see `normalizePhaseDurationMs`); a caller using the raw option instead
   * would compute a mismatched, possibly `NaN` or negative, progress value.
   */
  get durationMs(): number {
    return this.phaseDurationMs;
  }

  /**
   * Elapsed time (ms) within the current phase, in `[0, durationMs)`.
   * Exposed as a fraction via `progress` for callers driving continuous
   * visuals (scan wave sweep, node reveal staggering) from phase state.
   */
  get progress(): number {
    return this.elapsedInPhaseMs / this.phaseDurationMs;
  }

  /**
   * Advances the internal clock by `deltaMs`. Returns the number of phase
   * transitions that occurred (0 if still within the current phase's
   * dwell time; can be >1 if `deltaMs` spans multiple phase durations).
   */
  tick(deltaMs: number): number {
    if (deltaMs < 0 || !Number.isFinite(deltaMs)) {
      return 0;
    }
    this.elapsedInPhaseMs += deltaMs;
    if (this.elapsedInPhaseMs < this.phaseDurationMs) {
      return 0;
    }

    // Transition *count* is computed via division/modulo rather than a
    // `while` loop that repeatedly subtracts `phaseDurationMs`: an
    // unbounded or very large `deltaMs` (e.g. the tab was backgrounded for
    // a long time) would otherwise force a number of loop iterations
    // proportional to elapsed time before returning. Applying the phase
    // change still goes through `nextPhase` (the single source of truth
    // for phase order/wraparound, see module doc), but only
    // `transitions % cycleLength` times — at most `cycleLength - 1`
    // bounded iterations, since a full cycle is a no-op on `currentPhase`.
    const cycleLength = NARRATIVE_PHASES.length;
    const transitions = Math.floor(this.elapsedInPhaseMs / this.phaseDurationMs);
    this.elapsedInPhaseMs -= transitions * this.phaseDurationMs;

    const stepsToApply = transitions % cycleLength;
    for (let i = 0; i < stepsToApply; i += 1) {
      this.currentPhase = nextPhase(this.currentPhase);
    }

    return transitions;
  }

  /** Resets the clock back to IDLE with no elapsed progress. */
  reset(): void {
    this.currentPhase = "IDLE";
    this.elapsedInPhaseMs = 0;
  }
}
