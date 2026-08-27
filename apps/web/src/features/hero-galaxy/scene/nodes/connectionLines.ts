import * as THREE from "three";
import { HERO_GALAXY_PALETTE } from "../palette.js";
import type { AgentNodePosition } from "./agentNodeLayout.js";

/**
 * Rendering "kind" of a task-core-to-Agent-node connection line:
 * - "solid": Cyber Blue, verified/connected (a qualifying Agent during
 *   MATCHING, or a TOP_SCORE candidate at CANDIDATES_SELECTED).
 * - "exploration": the differentiated dashed / lower-contrast purple
 *   treatment for the newcomer/exploration slot (PRD §10.1: "差异化虚线或
 *   弱对比紫色：新人探索位"), used for the EXPLORATION candidate at
 *   CANDIDATES_SELECTED.
 * - "accepted" (T-303, narrative stage 4 "接单质押"): Orange, solid — the
 *   one candidate that accepted the task, from STAKE_LOCKED through
 *   EXECUTING/RESULT_RETURNED (the delivery visual travels along this
 *   line).
 * - "settled" (T-303, stage 6 "链上结算"): Emerald Green, solid — the
 *   accepted connection once SETTLED, signaling verification success and
 *   settlement.
 * - "hidden": fully transparent — no connection currently drawn (IDLE, a
 *   disqualified node during MATCHING, or a candidate that did not proceed
 *   past CANDIDATES_SELECTED/STAKE_LOCKED).
 */
export type ConnectionKind = "solid" | "exploration" | "accepted" | "settled" | "hidden";

export interface ConnectionLinesHandle {
  group: THREE.Group;
  lines: THREE.Line[];
  setConnection(index: number, kind: ConnectionKind): void;
  setAllConnections(kind: ConnectionKind): void;
}

const SOLID_OPACITY = 0.85;
const EXPLORATION_OPACITY = 0.55;
const ACCEPTED_OPACITY = 0.9;
const SETTLED_OPACITY = 0.9;

/**
 * Builds one line per Agent position, from the task core (origin) out to
 * that Agent's fixed position. Each line starts `hidden`.
 */
export function createConnectionLines(positions: AgentNodePosition[]): ConnectionLinesHandle {
  const group = new THREE.Group();
  const origin = new THREE.Vector3(0, 0, 0);

  // Tracks each line's current kind so `applyKind` can no-op when a caller
  // re-asserts the same kind — the per-phase render loop calls
  // setConnection()/setAllConnections() every frame (once per node during
  // MATCHING, and on every IDLE frame), and without this guard each of
  // those calls allocated and disposed a fresh Three.js material, churning
  // GPU resources at up to 60Hz for state that hadn't actually changed.
  const currentKinds: ConnectionKind[] = positions.map(() => "hidden");

  const lines = positions.map((position) => {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      origin,
      new THREE.Vector3(position.x, position.y, position.z),
    ]);
    const material = createMaterialForKind("hidden");
    const line = new THREE.Line(geometry, material);
    group.add(line);
    return line;
  });

  function setConnection(index: number, kind: ConnectionKind): void {
    const line = lines[index];
    if (!line) {
      return;
    }
    if (currentKinds[index] === kind) {
      return;
    }
    currentKinds[index] = kind;
    applyKind(line, kind);
  }

  function setAllConnections(kind: ConnectionKind): void {
    lines.forEach((_line, index) => setConnection(index, kind));
  }

  return { group, lines, setConnection, setAllConnections };
}

/**
 * `solid` and `exploration` require different Three.js material *classes*
 * (LineBasicMaterial vs LineDashedMaterial — dashing is not a property you
 * can toggle on a single material), so switching kind replaces the line's
 * material outright rather than mutating one in place. The previous
 * material is disposed immediately to avoid leaking one material per state
 * change over the animation's repeating narrative loop. Callers must only
 * invoke this when `kind` has actually changed (see `currentKinds` guard in
 * `setConnection`) — it always allocates, regardless of the line's current
 * material.
 */
function applyKind(line: THREE.Line, kind: ConnectionKind): void {
  const previousMaterial = line.material as THREE.Material;
  line.material = createMaterialForKind(kind);
  if (kind === "exploration") {
    // LineDashedMaterial (and dash rendering generally) requires per-line
    // distance attributes computed from its geometry.
    line.computeLineDistances();
  }
  previousMaterial.dispose();
}

function createMaterialForKind(kind: ConnectionKind): THREE.Material {
  switch (kind) {
    case "solid":
      return new THREE.LineBasicMaterial({
        color: HERO_GALAXY_PALETTE.cyberBlue,
        transparent: true,
        opacity: SOLID_OPACITY,
      });
    case "exploration":
      return new THREE.LineDashedMaterial({
        color: HERO_GALAXY_PALETTE.explorationPurple,
        dashSize: 0.12,
        gapSize: 0.08,
        transparent: true,
        opacity: EXPLORATION_OPACITY,
      });
    case "accepted":
      return new THREE.LineBasicMaterial({
        color: HERO_GALAXY_PALETTE.stakingOrange,
        transparent: true,
        opacity: ACCEPTED_OPACITY,
      });
    case "settled":
      return new THREE.LineBasicMaterial({
        color: HERO_GALAXY_PALETTE.settlementGreen,
        transparent: true,
        opacity: SETTLED_OPACITY,
      });
    case "hidden":
    default:
      return new THREE.LineBasicMaterial({
        color: HERO_GALAXY_PALETTE.cyberBlue,
        transparent: true,
        opacity: 0,
      });
  }
}
