import { describe, expect, it } from "vitest";
import { isMissingVectorExtensionError } from "./migrate.js";

// Feature 13 (T-1300): the exact message text Postgres genuinely returned
// when 0015_create_vector_recall_scoring.sql's `CREATE EXTENSION vector`
// ran against this project's local Postgres before pgvector was installed
// at the OS level (confirmed once, manually, during T-1300 development —
// installing pgvector afterward was necessary to test the rest of Feature
// 13 for real, which makes that specific failure impossible to reproduce
// against a live database from this point on; this unit test is what keeps
// the detection logic itself covered).
const REAL_MISSING_EXTENSION_MESSAGE = 'extension "vector" is not available';

describe("isMissingVectorExtensionError", () => {
  it("recognizes Postgres's real missing-extension error message", () => {
    expect(isMissingVectorExtensionError(new Error(REAL_MISSING_EXTENSION_MESSAGE))).toBe(true);
  });

  it("does not misclassify an unrelated error as a missing-extension error", () => {
    expect(isMissingVectorExtensionError(new Error('relation "agents" already exists'))).toBe(
      false,
    );
    expect(isMissingVectorExtensionError(new Error('syntax error at or near "CREATE"'))).toBe(
      false,
    );
  });

  it("returns false for a non-Error value", () => {
    expect(isMissingVectorExtensionError('extension "vector" is not available')).toBe(false);
    expect(isMissingVectorExtensionError(null)).toBe(false);
    expect(isMissingVectorExtensionError(undefined)).toBe(false);
  });
});
