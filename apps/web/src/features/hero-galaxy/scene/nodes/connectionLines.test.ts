import { describe, expect, it } from "vitest";
import type { Line } from "three";
import { createConnectionLines } from "./connectionLines.js";
import type { AgentNodePosition } from "./agentNodeLayout.js";
import { HERO_GALAXY_PALETTE } from "../palette.js";

const POSITIONS: AgentNodePosition[] = [
  { index: 0, x: 1, y: 0, z: 0 },
  { index: 1, x: 0, y: 1, z: 0 },
];

/** Test-only helper: index into `lines` without a non-null assertion. */
function requireLine(lines: Line[], index: number): Line {
  const line = lines[index];
  if (!line) {
    throw new Error(`expected a line at index ${index}`);
  }
  return line;
}

describe("createConnectionLines", () => {
  it("re-asserting the same kind does not allocate/dispose a new material", () => {
    // Codex review finding: the per-phase render loop calls
    // setConnection()/setAllConnections() every frame regardless of
    // whether the kind actually changed, and the old implementation always
    // replaced the material, churning GPU resources at animation frame
    // rate. Re-asserting an unchanged kind must now be a no-op.
    const { lines, setConnection } = createConnectionLines(POSITIONS);
    setConnection(0, "solid");
    const materialAfterFirstSet = requireLine(lines, 0).material;

    setConnection(0, "solid");
    expect(requireLine(lines, 0).material).toBe(materialAfterFirstSet);

    setConnection(0, "solid");
    expect(requireLine(lines, 0).material).toBe(materialAfterFirstSet);
  });

  it("changing kind does replace the material", () => {
    const { lines, setConnection } = createConnectionLines(POSITIONS);
    setConnection(0, "solid");
    const solidMaterial = requireLine(lines, 0).material;

    setConnection(0, "exploration");
    expect(requireLine(lines, 0).material).not.toBe(solidMaterial);
  });

  it("setAllConnections is idempotent across repeated calls with the same kind", () => {
    const { lines, setAllConnections } = createConnectionLines(POSITIONS);
    setAllConnections("hidden");
    const materials = lines.map((line) => line.material);

    setAllConnections("hidden");
    lines.forEach((line, index) => {
      expect(line.material).toBe(materials[index]);
    });
  });

  it("supports the T-303 'accepted' (Orange) and 'settled' (Emerald Green) kinds", () => {
    const { lines, setConnection } = createConnectionLines(POSITIONS);

    setConnection(0, "accepted");
    const acceptedMaterial = requireLine(lines, 0).material as import("three").LineBasicMaterial;
    expect(acceptedMaterial.color.getHex()).toBe(HERO_GALAXY_PALETTE.stakingOrange);

    setConnection(0, "settled");
    const settledMaterial = requireLine(lines, 0).material as import("three").LineBasicMaterial;
    expect(settledMaterial.color.getHex()).toBe(HERO_GALAXY_PALETTE.settlementGreen);
  });
});
