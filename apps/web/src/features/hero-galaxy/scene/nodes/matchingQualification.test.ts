import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_NODE_COUNT } from "./agentNodeLayout.js";
import { isAgentQualified } from "./matchingQualification.js";

describe("isAgentQualified", () => {
  it("is a pure, deterministic function of index (same input -> same output across repeated calls)", () => {
    for (let index = 0; index < DEFAULT_AGENT_NODE_COUNT; index += 1) {
      const first = isAgentQualified(index);
      const second = isAgentQualified(index);
      expect(second).toBe(first);
    }
  });

  it("qualifies at least one and disqualifies at least one node across the default ring size", () => {
    const results = Array.from({ length: DEFAULT_AGENT_NODE_COUNT }, (_, i) => isAgentQualified(i));
    expect(results).toContain(true);
    expect(results).toContain(false);
  });
});
