import { describe, expect, it } from "vitest";
import { parseRuleBasedCriteria } from "./repository.js";

describe("parseRuleBasedCriteria", () => {
  it("accepts a well-formed KEYWORD_PRESENCE rubric", () => {
    const result = parseRuleBasedCriteria({
      type: "KEYWORD_PRESENCE",
      requiredKeywords: ["recursion", "base case"],
    });
    expect(result).toEqual({
      type: "KEYWORD_PRESENCE",
      requiredKeywords: ["recursion", "base case"],
    });
  });

  it("rejects a malformed shape (wrong type discriminator)", () => {
    expect(parseRuleBasedCriteria({ type: "SOMETHING_ELSE", requiredKeywords: [] })).toBeNull();
  });

  it("rejects null/undefined/non-object input", () => {
    expect(parseRuleBasedCriteria(null)).toBeNull();
    expect(parseRuleBasedCriteria(undefined)).toBeNull();
    expect(parseRuleBasedCriteria("not an object")).toBeNull();
  });

  it("N4 P2 fix: rejects a blank or whitespace-only keyword (would make String.includes('') trivially true for every submission)", () => {
    expect(parseRuleBasedCriteria({ type: "KEYWORD_PRESENCE", requiredKeywords: [""] })).toBeNull();
    expect(
      parseRuleBasedCriteria({ type: "KEYWORD_PRESENCE", requiredKeywords: ["   "] }),
    ).toBeNull();
    expect(
      parseRuleBasedCriteria({ type: "KEYWORD_PRESENCE", requiredKeywords: ["recursion", ""] }),
    ).toBeNull();
  });
});
