import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_NODE_COUNT } from "./agentNodeLayout.js";
import { isAgentQualified } from "./matchingQualification.js";
import { selectAcceptedCandidate, selectCandidates } from "./candidateSelection.js";

describe("selectCandidates", () => {
  it("is a pure, deterministic function of nodeCount (same input -> same output)", () => {
    const first = selectCandidates(DEFAULT_AGENT_NODE_COUNT);
    const second = selectCandidates(DEFAULT_AGENT_NODE_COUNT);
    expect(second).toEqual(first);
  });

  it("picks three distinct indices: two TOP_SCORE and one EXPLORATION", () => {
    const selection = selectCandidates(DEFAULT_AGENT_NODE_COUNT);
    const all = [...selection.topScore, selection.exploration];
    expect(new Set(all).size).toBe(3);
  });

  it("every selected index is qualified per isAgentQualified, when enough nodes qualify", () => {
    const selection = selectCandidates(DEFAULT_AGENT_NODE_COUNT);
    expect(isAgentQualified(selection.topScore[0])).toBe(true);
    expect(isAgentQualified(selection.topScore[1])).toBe(true);
    expect(isAgentQualified(selection.exploration)).toBe(true);
  });

  it("every selected index is within [0, nodeCount)", () => {
    const nodeCount = 8;
    const selection = selectCandidates(nodeCount);
    for (const index of [...selection.topScore, selection.exploration]) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(nodeCount);
    }
  });

  it("never throws and stays in-bounds even when fewer than 3 nodes qualify", () => {
    // isAgentQualified(index) is `index % 3 !== 2`; a nodeCount of 1 leaves
    // exactly one qualified index (0), well under the 3 candidates needed.
    expect(() => selectCandidates(1)).not.toThrow();
    const selection = selectCandidates(1);
    for (const index of [...selection.topScore, selection.exploration]) {
      expect(index).toBe(0);
    }
  });

  it("defaults to DEFAULT_AGENT_NODE_COUNT when called with no argument", () => {
    expect(selectCandidates()).toEqual(selectCandidates(DEFAULT_AGENT_NODE_COUNT));
  });
});

describe("selectAcceptedCandidate", () => {
  it("is deterministic and always returns one of the three candidates", () => {
    const selection = selectCandidates(DEFAULT_AGENT_NODE_COUNT);
    const accepted = selectAcceptedCandidate(selection);
    const second = selectAcceptedCandidate(selection);
    expect(accepted).toBe(second);
    expect([...selection.topScore, selection.exploration]).toContain(accepted);
  });

  it("picks the first TOP_SCORE candidate", () => {
    const selection = selectCandidates(DEFAULT_AGENT_NODE_COUNT);
    expect(selectAcceptedCandidate(selection)).toBe(selection.topScore[0]);
  });
});
