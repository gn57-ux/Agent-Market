/**
 * Deterministic, demo-only qualification rule used by the MATCHING phase's
 * scanning wave to decide which Agent nodes light up (qualify, Amethyst
 * Purple + connect to the task core) versus dim to low-brightness gray
 * (disqualify) as the wave sweeps past them.
 *
 * Kept as a pure function, framework-free, so "which nodes matter" is
 * unit-testable without Three.js, and so CANDIDATES_SELECTED (T-303) can
 * reuse this same qualification set instead of re-deriving it independently
 * (project rule: 设计知识只能有一个归属).
 *
 * The specific ratio is an illustrative demo pattern, not a real matching
 * algorithm — PRD §10.1 explicitly notes the animation's tasks/scores/
 * addresses/funds are mechanism-demonstration data, not real metrics.
 */
export function isAgentQualified(index: number): boolean {
  return index % 3 !== 2;
}
