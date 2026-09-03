import { describe, expect, it } from "vitest";
import { ERROR_CODES, isErrorCode } from "../src/error-codes.js";

// PRD §11.4's exact list — this test fails if the module drifts from the spec.
const PRD_ERROR_CODES = [
  "WALLET_SIGNATURE_INVALID",
  "CHAIN_UNSUPPORTED",
  "TRANSACTION_NOT_FOUND",
  "TRANSACTION_NOT_CONFIRMED",
  "FUNDING_EVENT_MISMATCH",
  "TRANSACTION_ALREADY_USED",
  "TASK_STATE_CONFLICT",
  "IDEMPOTENCY_KEY_CONFLICT",
  "NO_ELIGIBLE_AGENT",
  "ACCEPTANCE_PERMIT_EXPIRED",
  "DELIVERABLE_HASH_MISMATCH",
  "RPC_TEMPORARILY_UNAVAILABLE",
];

describe("ERROR_CODES", () => {
  it("exports exactly the PRD §11.4 list (order-independent, no extras, no omissions)", () => {
    expect([...ERROR_CODES].sort()).toEqual([...PRD_ERROR_CODES].sort());
  });

  it.each(PRD_ERROR_CODES)("includes %s", (code) => {
    expect(ERROR_CODES).toContain(code);
  });

  it("isErrorCode distinguishes known codes from arbitrary strings", () => {
    expect(isErrorCode("TASK_STATE_CONFLICT")).toBe(true);
    expect(isErrorCode("NOT_A_REAL_CODE")).toBe(false);
  });
});
