/**
 * Pure geometry for the Agent node ring: given a count and radius, computes
 * evenly-spaced positions on the XY plane around the task core at the
 * origin. Kept framework-free (no Three.js import) so it is trivially unit
 * testable and reusable by `nodes/agentNodes.ts` and `nodes/connectionLines.ts`
 * without either module re-deriving the layout independently.
 */

export interface AgentNodePosition {
  /** Index into the ring, in [0, count). */
  index: number;
  x: number;
  y: number;
  z: number;
}

export interface AgentRingLayoutOptions {
  /** Number of Agent nodes in the ring. Defaults to `DEFAULT_AGENT_NODE_COUNT`. */
  count?: number;
  /** Ring radius (scene units). Defaults to `DEFAULT_AGENT_RING_RADIUS`. */
  radius?: number;
}

/**
 * One-period Agent count for the desktop composition (PRD §10.1's static
 * reference shows a task core surrounded by a small outer node network,
 * not a dense field). Mobile/simplified compositions are T-305's job.
 */
export const DEFAULT_AGENT_NODE_COUNT = 8;

/** Ring radius in scene units, chosen to sit clear of the task core (r≈0.6) and within the camera's default frustum (camera z=8). */
export const DEFAULT_AGENT_RING_RADIUS = 3.2;

/**
 * Computes `count` positions evenly spaced around a circle of `radius` in
 * the XY plane (z=0), starting at angle 0 (positive X axis) and proceeding
 * counter-clockwise. Returns an empty array for `count <= 0`.
 */
export function computeAgentRingPositions(
  options: AgentRingLayoutOptions = {},
): AgentNodePosition[] {
  const count = options.count ?? DEFAULT_AGENT_NODE_COUNT;
  const radius = options.radius ?? DEFAULT_AGENT_RING_RADIUS;

  if (count <= 0) {
    return [];
  }

  const positions: AgentNodePosition[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    positions.push({
      index,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      z: 0,
    });
  }
  return positions;
}
