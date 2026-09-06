import { describe, expect, it } from "vitest";
import { scoreKeywordPresence, scoreRuleBased } from "./rule-scorer.js";

describe("scoreKeywordPresence", () => {
  it("scores 100 when every required keyword is present (case-insensitive)", () => {
    const result = scoreKeywordPresence("This Answer covers RECURSION and Base Cases.", {
      type: "KEYWORD_PRESENCE",
      requiredKeywords: ["recursion", "base case"],
    });
    expect(result.score).toBe(100);
    expect(result.rationale).toContain("2/2");
  });

  it("scores 0 when no required keyword is present", () => {
    const result = scoreKeywordPresence("something unrelated", {
      type: "KEYWORD_PRESENCE",
      requiredKeywords: ["recursion", "base case"],
    });
    expect(result.score).toBe(0);
    expect(result.rationale).toContain("0/2");
  });

  it("scores a partial match proportionally and lists exactly which keywords are missing", () => {
    const result = scoreKeywordPresence("only mentions recursion", {
      type: "KEYWORD_PRESENCE",
      requiredKeywords: ["recursion", "base case", "stack"],
    });
    expect(result.score).toBeCloseTo(33.33, 1);
    expect(result.rationale).toContain("1/3");
    expect(result.rationale).toContain("base case");
    expect(result.rationale).toContain("stack");
  });

  it("does not silently score 100 when the rubric defines zero keywords", () => {
    const result = scoreKeywordPresence("anything", {
      type: "KEYWORD_PRESENCE",
      requiredKeywords: [],
    });
    expect(result.score).toBe(0);
    expect(result.rationale).toContain("未定义任何关键要素");
  });
});

describe("scoreRuleBased", () => {
  it("dispatches KEYWORD_PRESENCE criteria to scoreKeywordPresence", () => {
    const result = scoreRuleBased("has recursion", {
      type: "KEYWORD_PRESENCE",
      requiredKeywords: ["recursion"],
    });
    expect(result.score).toBe(100);
  });
});
