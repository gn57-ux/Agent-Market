import type { TransactionStatus } from "@agent-market/domain";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TransactionStatusView } from "./TransactionStatus.js";

const TX_HASH = "0x1" as const;

// Exhaustive: one sample per TransactionStatus variant (all 8), including
// the two recoverable states added in the 2026-08-22 simplification round.
const SAMPLES: Array<{ status: TransactionStatus; expectedSubstring: string }> = [
  { status: { kind: "idle" }, expectedSubstring: "" },
  { status: { kind: "awaitingSignature" }, expectedSubstring: "签名" },
  { status: { kind: "pending", txHash: TX_HASH }, expectedSubstring: "提交" },
  {
    status: { kind: "confirming", txHash: TX_HASH, confirmations: 2 },
    expectedSubstring: "2 次确认",
  },
  { status: { kind: "verifying", txHash: TX_HASH }, expectedSubstring: "复核" },
  {
    status: {
      kind: "rpcRecoveryPending",
      txHash: TX_HASH,
      lastError: "RPC_TEMPORARILY_UNAVAILABLE",
    },
    expectedSubstring: "重试",
  },
  { status: { kind: "confirmed", txHash: TX_HASH }, expectedSubstring: "已确认" },
  {
    status: { kind: "failed", reason: "TASK_STATE_CONFLICT" },
    expectedSubstring: "TASK_STATE_CONFLICT",
  },
];

describe("TransactionStatusView", () => {
  it.each(SAMPLES)(
    "renders $status.kind containing $expectedSubstring",
    ({ status, expectedSubstring }) => {
      const { container } = render(<TransactionStatusView status={status} />);
      expect(container.textContent).toContain(expectedSubstring);
    },
  );

  it("covers every TransactionStatus variant (exhaustiveness sanity check)", () => {
    expect(SAMPLES).toHaveLength(8);
  });
});
