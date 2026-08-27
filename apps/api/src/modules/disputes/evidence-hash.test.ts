import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeEvidenceHash } from "./evidence-hash.js";

describe("computeEvidenceHash", () => {
  it("returns a 0x-prefixed lowercase hex sha256 digest", () => {
    const hash = computeEvidenceHash("the agent's deliverable does not match the spec");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("matches an independently computed sha256 of the trimmed input", () => {
    const input = "  evidence text with surrounding whitespace  ";
    const expected = `0x${createHash("sha256").update(input.trim(), "utf8").digest("hex")}`;
    expect(computeEvidenceHash(input)).toBe(expected);
  });

  it("is deterministic for the same input", () => {
    expect(computeEvidenceHash("same text")).toBe(computeEvidenceHash("same text"));
  });

  it("produces different hashes for different input", () => {
    expect(computeEvidenceHash("text A")).not.toBe(computeEvidenceHash("text B"));
  });

  it("trims surrounding whitespace before hashing, so incidental padding does not change the digest", () => {
    expect(computeEvidenceHash("some evidence")).toBe(computeEvidenceHash("  some evidence  "));
  });
});
