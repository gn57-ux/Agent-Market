import { describe, expect, it } from "vitest";
import {
  computeAgentRingPositions,
  DEFAULT_AGENT_NODE_COUNT,
  DEFAULT_AGENT_RING_RADIUS,
  type AgentNodePosition,
} from "./agentNodeLayout.js";

/**
 * `noUncheckedIndexedAccess` types array indexing as possibly `undefined`.
 * This test file indexes fixed-length arrays it just asserted the length
 * of, so those accesses can never actually be `undefined` — this helper
 * narrows the type without a forbidden non-null assertion (project rule:
 * no `!`), by throwing (failing the test loudly) if the invariant is ever
 * violated.
 */
function at(positions: AgentNodePosition[], index: number): AgentNodePosition {
  const position = positions[index];
  if (!position) {
    throw new Error(`expected a position at index ${index}`);
  }
  return position;
}

describe("computeAgentRingPositions", () => {
  it("defaults to DEFAULT_AGENT_NODE_COUNT positions on the DEFAULT_AGENT_RING_RADIUS circle", () => {
    const positions = computeAgentRingPositions();
    expect(positions).toHaveLength(DEFAULT_AGENT_NODE_COUNT);
    for (const position of positions) {
      const distanceFromOrigin = Math.hypot(position.x, position.y);
      expect(distanceFromOrigin).toBeCloseTo(DEFAULT_AGENT_RING_RADIUS, 10);
      expect(position.z).toBe(0);
    }
  });

  it("returns exactly `count` positions, each carrying its own index", () => {
    const positions = computeAgentRingPositions({ count: 5, radius: 2 });
    expect(positions).toHaveLength(5);
    expect(positions.map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("spaces positions evenly around the circle", () => {
    const positions = computeAgentRingPositions({ count: 4, radius: 1 });
    expect(positions).toHaveLength(4);
    // 4 evenly-spaced points starting at angle 0 land on the axes.
    expect(at(positions, 0).x).toBeCloseTo(1, 10);
    expect(at(positions, 0).y).toBeCloseTo(0, 10);
    expect(at(positions, 1).x).toBeCloseTo(0, 10);
    expect(at(positions, 1).y).toBeCloseTo(1, 10);
    expect(at(positions, 2).x).toBeCloseTo(-1, 10);
    expect(at(positions, 2).y).toBeCloseTo(0, 10);
    expect(at(positions, 3).x).toBeCloseTo(0, 10);
    expect(at(positions, 3).y).toBeCloseTo(-1, 10);
  });

  it("scales with the requested radius", () => {
    const unit = computeAgentRingPositions({ count: 6, radius: 1 });
    const scaled = computeAgentRingPositions({ count: 6, radius: 10 });
    expect(scaled).toHaveLength(unit.length);
    for (let i = 0; i < unit.length; i += 1) {
      expect(at(scaled, i).x).toBeCloseTo(at(unit, i).x * 10, 10);
      expect(at(scaled, i).y).toBeCloseTo(at(unit, i).y * 10, 10);
    }
  });

  it("returns an empty array for count <= 0", () => {
    expect(computeAgentRingPositions({ count: 0 })).toEqual([]);
    expect(computeAgentRingPositions({ count: -3 })).toEqual([]);
  });
});
