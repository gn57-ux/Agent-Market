import { afterEach, describe, expect, it } from "vitest";
import { resolveMonthlyEmbeddingBudget } from "./budget.js";

const ENV_VAR = "EMBEDDING_MONTHLY_BUDGET";

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe("resolveMonthlyEmbeddingBudget", () => {
  it("defaults to a positive number when the env var is unset", () => {
    const value = resolveMonthlyEmbeddingBudget();
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });

  it("reads a valid positive integer from the env var", () => {
    process.env[ENV_VAR] = "500";
    expect(resolveMonthlyEmbeddingBudget()).toBe(500);
  });

  it("allows an explicit 0 (disables embedding entirely)", () => {
    process.env[ENV_VAR] = "0";
    expect(resolveMonthlyEmbeddingBudget()).toBe(0);
  });

  it("falls back to the default for a negative or non-numeric value", () => {
    const fallback = (() => {
      delete process.env[ENV_VAR];
      return resolveMonthlyEmbeddingBudget();
    })();

    process.env[ENV_VAR] = "-5";
    expect(resolveMonthlyEmbeddingBudget()).toBe(fallback);

    process.env[ENV_VAR] = "not-a-number";
    expect(resolveMonthlyEmbeddingBudget()).toBe(fallback);
  });
});
