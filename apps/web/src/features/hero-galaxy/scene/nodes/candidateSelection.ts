import { DEFAULT_AGENT_NODE_COUNT } from "./agentNodeLayout.js";
import { isAgentQualified } from "./matchingQualification.js";

/**
 * Deterministic, demo-only rule for narrative stage 3 ("候选形成", PRD
 * §10.1): from the set of nodes MATCHING already qualified
 * (`isAgentQualified`), pick exactly two `TOP_SCORE` (high-score) candidates
 * and one `EXPLORATION` (newcomer) candidate.
 *
 * Kept pure/framework-free (no Three.js import) — same style as
 * `matchingQualification.ts` — so "which three nodes become candidates" is
 * unit-testable without a scene, and so this single rule is the one place
 * that owns the CANDIDATES_SELECTED node selection (project rule: 设计知识
 * 只能有一个归属). `IntentRoutingGalaxy.ts` must call this once per
 * narrative cycle and hold the result stable through STAKE_LOCKED..SETTLED —
 * see the caller's `ensureCandidatesComputed` guard — rather than
 * re-deriving it every frame.
 *
 * The specific selection pattern (first two qualified nodes -> TOP_SCORE,
 * next qualified node -> EXPLORATION) is an illustrative demo pattern, not a
 * real scoring algorithm — PRD §10.1 explicitly notes the animation's
 * tasks/scores/addresses/funds are mechanism-demonstration data, not real
 * metrics (F-308/AC-306).
 */
export interface CandidateSelection {
  /** The two TOP_SCORE (high-score) candidate node indices. */
  topScore: [number, number];
  /** The one EXPLORATION (newcomer) candidate node index. */
  exploration: number;
}

/**
 * Selects candidate node indices out of `nodeCount` total Agent nodes.
 * Never throws: if fewer than 3 nodes qualify under `isAgentQualified` (a
 * pathologically small ring), the selection degrades by wrapping to
 * `index % nodeCount` for any missing slot rather than producing an invalid
 * index or an exception — this function runs inside the render loop's
 * per-frame path (indirectly, via the caller's once-per-cycle memoization),
 * so it must stay safe for any `nodeCount >= 1`.
 */
export function selectCandidates(nodeCount: number = DEFAULT_AGENT_NODE_COUNT): CandidateSelection {
  const count = Math.max(Math.floor(nodeCount), 1);

  const qualifiedIndices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (isAgentQualified(index)) {
      qualifiedIndices.push(index);
    }
  }

  function pickSlot(position: number, fallback: number): number {
    const candidate = qualifiedIndices[position];
    return candidate !== undefined ? candidate : fallback % count;
  }

  const topScoreA = pickSlot(0, 0);
  const topScoreB = pickSlot(1, 1);
  const exploration = pickSlot(2, 2);

  return { topScore: [topScoreA, topScoreB], exploration };
}

/**
 * Selects which of the three CANDIDATES_SELECTED candidates "accepts" the
 * task and proceeds to STAKE_LOCKED (PRD §10.1 stage 4: "其中一个 Agent
 * 接单后形成橙色质押环"). Demo rule: the first TOP_SCORE candidate always
 * accepts — a simple, deterministic, illustrative stand-in for "the
 * highest-ranked candidate wins the task," not a real acceptance/auction
 * simulation.
 */
export function selectAcceptedCandidate(selection: CandidateSelection): number {
  return selection.topScore[0];
}
