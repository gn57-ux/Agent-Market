import * as THREE from "three";
import { HERO_GALAXY_PALETTE } from "../palette.js";
import {
  computeAgentRingPositions,
  DEFAULT_AGENT_NODE_COUNT,
  DEFAULT_AGENT_RING_RADIUS,
} from "./agentNodeLayout.js";

/**
 * Visual state of a single Agent node, per PRD §10.1's visual-semantic
 * table:
 * - "idle": network present but no active matching round (dormant Amethyst
 *   Purple, dimmed via opacity rather than recolored — the node is still an
 *   eligible Agent, just not currently being evaluated).
 * - "eligible": Amethyst Purple at full opacity — AI Agent / matching
 *   computation / high-score candidate.
 * - "disqualified": 低亮灰色 — failed qualification, not selected this
 *   round, or (from CANDIDATES_SELECTED onward) a candidate that did not
 *   proceed ("其余候选退出当前任务轨道").
 * - "topScore" (T-303, narrative stage 3 "候选形成"): one of the two
 *   TOP_SCORE candidates at CANDIDATES_SELECTED — Amethyst Purple like
 *   "eligible" but enlarged so it visually reads as highlighted/singled-out
 *   rather than merely "still qualified".
 * - "exploration" (T-303, stage 3): the one EXPLORATION candidate —
 *   `explorationPurple` (PRD's "差异化虚线或弱对比紫色：新人探索位"),
 *   slightly enlarged but at lower opacity than `topScore` so it reads as
 *   the differentiated/de-emphasized slot.
 * - "accepted" (T-303, stage 4 "接单质押"): the one candidate that accepted
 *   the task — Orange, enlarged, paired with the staking ring
 *   (`stakingRing.ts`) and an "accepted" connection kind.
 * - "settled" (T-303, stage 6 "链上结算"): the accepted node once SETTLED —
 *   Emerald Green, signaling verification success and settlement.
 */
export type AgentNodeState =
  "idle" | "eligible" | "disqualified" | "topScore" | "exploration" | "accepted" | "settled";

export interface AgentNodeHandle {
  group: THREE.Group;
  nodes: THREE.Mesh[];
  setState(index: number, state: AgentNodeState): void;
  setAllStates(state: AgentNodeState): void;
}

const NODE_RADIUS = 0.18;
const NODE_SEGMENTS = 16;

interface NodeAppearance {
  color: number;
  opacity: number;
  /** Uniform scale factor applied to the node mesh. Defaults to 1 (see `setState`). */
  scale?: number;
}

/** Scale used by every "highlighted, singled-out" state (T-303 candidate/accepted/settled states). */
const HIGHLIGHT_SCALE = 1.35;

const STATE_APPEARANCE: Record<AgentNodeState, NodeAppearance> = {
  idle: { color: HERO_GALAXY_PALETTE.amethystPurple, opacity: 0.35 },
  eligible: { color: HERO_GALAXY_PALETTE.amethystPurple, opacity: 1 },
  disqualified: { color: HERO_GALAXY_PALETTE.disqualifiedGray, opacity: 0.5 },
  topScore: { color: HERO_GALAXY_PALETTE.amethystPurple, opacity: 1, scale: HIGHLIGHT_SCALE },
  exploration: { color: HERO_GALAXY_PALETTE.explorationPurple, opacity: 0.8, scale: 1.15 },
  accepted: { color: HERO_GALAXY_PALETTE.stakingOrange, opacity: 1, scale: HIGHLIGHT_SCALE },
  settled: { color: HERO_GALAXY_PALETTE.settlementGreen, opacity: 1, scale: HIGHLIGHT_SCALE },
};

/**
 * Builds the outer ring of Agent nodes around the task core. Node
 * *positions* never change after construction (per T-302's brief: "later
 * candidate-selection phase (T-303) can highlight specific ones without
 * needing to reposition everything") — only per-node color/opacity state
 * changes via `setState`.
 */
export function createAgentNodeNetwork(
  count: number = DEFAULT_AGENT_NODE_COUNT,
  radius: number = DEFAULT_AGENT_RING_RADIUS,
): AgentNodeHandle {
  const positions = computeAgentRingPositions({ count, radius });
  const group = new THREE.Group();
  // Geometry is shared across all node meshes (identical spheres) —
  // disposing it once per mesh during scene teardown is safe (THREE
  // Geometry#dispose is idempotent) and avoids allocating N identical
  // BufferGeometry instances.
  const geometry = new THREE.SphereGeometry(NODE_RADIUS, NODE_SEGMENTS, NODE_SEGMENTS);

  const nodes = positions.map((position) => {
    const appearance = STATE_APPEARANCE.idle;
    const material = new THREE.MeshBasicMaterial({
      color: appearance.color,
      transparent: true,
      opacity: appearance.opacity,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position.x, position.y, position.z);
    group.add(mesh);
    return mesh;
  });

  function setState(index: number, state: AgentNodeState): void {
    const mesh = nodes[index];
    if (!mesh) {
      return;
    }
    const material = mesh.material as THREE.MeshBasicMaterial;
    const appearance = STATE_APPEARANCE[state];
    material.color.setHex(appearance.color);
    material.opacity = appearance.opacity;
    mesh.scale.setScalar(appearance.scale ?? 1);
  }

  function setAllStates(state: AgentNodeState): void {
    nodes.forEach((_, index) => setState(index, state));
  }

  return { group, nodes, setState, setAllStates };
}
