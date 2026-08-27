import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHASE_DURATION_MS,
  NARRATIVE_PHASES,
  NarrativePhaseClock,
  nextPhase,
  type NarrativePhase,
} from "./narrativePhase.js";

describe("nextPhase", () => {
  it("advances through the documented order IDLE -> ... -> SETTLED", () => {
    const observed: NarrativePhase[] = ["IDLE"];
    let current: NarrativePhase = "IDLE";
    for (let i = 0; i < NARRATIVE_PHASES.length - 1; i += 1) {
      current = nextPhase(current);
      observed.push(current);
    }
    expect(observed).toEqual([...NARRATIVE_PHASES]);
  });

  it("wraps SETTLED back to IDLE, closing the loop", () => {
    expect(nextPhase("SETTLED")).toBe("IDLE");
  });

  it("covers every phase exhaustively with no dead ends (full cycle + wraparound)", () => {
    let current: NarrativePhase = "IDLE";
    const visited: NarrativePhase[] = [];
    // One full cycle plus one extra step to prove wraparound continues
    // correctly (not just stopping at SETTLED).
    for (let i = 0; i < NARRATIVE_PHASES.length + 1; i += 1) {
      visited.push(current);
      current = nextPhase(current);
    }
    expect(visited).toEqual([...NARRATIVE_PHASES, "IDLE"]);
    expect(current).toBe("INTENT_CREATED");
  });

  it("every phase in NARRATIVE_PHASES has a defined, distinct successor", () => {
    for (const phase of NARRATIVE_PHASES) {
      const successor = nextPhase(phase);
      expect(NARRATIVE_PHASES).toContain(successor);
      expect(successor).not.toBe(phase);
    }
  });
});

describe("NarrativePhaseClock", () => {
  it("starts at IDLE by default", () => {
    const clock = new NarrativePhaseClock();
    expect(clock.phase).toBe("IDLE");
  });

  it("accepts a custom initial phase", () => {
    const clock = new NarrativePhaseClock({ initialPhase: "MATCHING" });
    expect(clock.phase).toBe("MATCHING");
  });

  it("does not advance before the phase duration has elapsed", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1000 });
    const transitions = clock.tick(500);
    expect(transitions).toBe(0);
    expect(clock.phase).toBe("IDLE");
  });

  it("advances exactly one phase once the duration is reached", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1000 });
    const transitions = clock.tick(1000);
    expect(transitions).toBe(1);
    expect(clock.phase).toBe("INTENT_CREATED");
  });

  it("advances multiple phases in a single large tick", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1000 });
    const transitions = clock.tick(3500);
    expect(transitions).toBe(3);
    expect(clock.phase).toBe("CANDIDATES_SELECTED");
  });

  it("falls back to the default duration for a zero phaseDurationMs (no infinite loop)", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 0 });
    // A zero duration must not cause tick() to spin forever; it should
    // behave as if the default duration were used instead.
    expect(clock.tick(DEFAULT_PHASE_DURATION_MS)).toBe(1);
    expect(clock.phase).toBe("INTENT_CREATED");
  });

  it("falls back to the default duration for a negative phaseDurationMs", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: -500 });
    expect(clock.tick(DEFAULT_PHASE_DURATION_MS)).toBe(1);
    expect(clock.phase).toBe("INTENT_CREATED");
  });

  it("falls back to the default duration for a NaN phaseDurationMs (no permanent stall)", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: Number.NaN });
    expect(clock.tick(DEFAULT_PHASE_DURATION_MS)).toBe(1);
    expect(clock.phase).toBe("INTENT_CREATED");
  });

  it("falls back to the default duration for an Infinity phaseDurationMs", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: Number.POSITIVE_INFINITY });
    expect(clock.tick(DEFAULT_PHASE_DURATION_MS)).toBe(1);
    expect(clock.phase).toBe("INTENT_CREATED");
  });

  it("falls back to the default duration for a sub-minimum duration (e.g. 1e-300)", () => {
    // Codex review finding: a duration this small could fail to reduce
    // elapsedInPhaseMs under floating-point subtraction, or otherwise
    // produce unbounded transitions per tick. It must be rejected the same
    // way 0/negative/NaN/Infinity are.
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1e-300 });
    expect(clock.tick(DEFAULT_PHASE_DURATION_MS)).toBe(1);
    expect(clock.phase).toBe("INTENT_CREATED");
  });

  it("resolves a huge delta spanning many full cycles in O(1), not proportional iterations", () => {
    // With phaseDurationMs=1, a delta of ~1 billion ms would previously
    // have driven ~1 billion loop iterations (a page freeze). The
    // division/modulo implementation must resolve this instantly and land
    // on the mathematically correct phase.
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1 });
    const hugeDeltaMs = 1_000_000_003; // NARRATIVE_PHASES.length (8) * 125_000_000 + 3
    const transitions = clock.tick(hugeDeltaMs);
    expect(transitions).toBe(hugeDeltaMs);
    // 1_000_000_003 % 8 === 3 -> IDLE + 3 steps = CANDIDATES_SELECTED
    expect(clock.phase).toBe("CANDIDATES_SELECTED");
  });

  it("carries correct leftover elapsed time across a huge-delta tick", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1000 });
    clock.tick(1_000_000_500); // 1_000_000 whole phases + 500ms remainder
    // A subsequent half-duration tick should not yet cross into the next
    // phase (500 + 499 < 1000), proving elapsedInPhaseMs was tracked
    // correctly through the division/modulo path, not reset to 0.
    expect(clock.tick(499)).toBe(0);
    expect(clock.tick(1)).toBe(1);
  });

  it("loops back to IDLE after a full cycle of ticks", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1000 });
    const seen: NarrativePhase[] = [clock.phase];
    for (let i = 0; i < NARRATIVE_PHASES.length; i += 1) {
      clock.tick(1000);
      seen.push(clock.phase);
    }
    expect(seen).toEqual([...NARRATIVE_PHASES, "IDLE"]);
  });

  it("ignores negative or non-finite deltas without throwing or advancing", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1000 });
    expect(clock.tick(-100)).toBe(0);
    expect(clock.tick(Number.NaN)).toBe(0);
    expect(clock.tick(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clock.phase).toBe("IDLE");
  });

  it("reset() returns the clock to IDLE with no carried-over progress", () => {
    const clock = new NarrativePhaseClock({ phaseDurationMs: 1000 });
    clock.tick(2500);
    expect(clock.phase).toBe("MATCHING");
    clock.reset();
    expect(clock.phase).toBe("IDLE");
    // No leftover elapsed time from before reset: a single half-duration
    // tick should not immediately roll into the next phase.
    expect(clock.tick(500)).toBe(0);
    expect(clock.phase).toBe("IDLE");
  });
});
