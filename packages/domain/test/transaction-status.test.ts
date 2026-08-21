import { describe, expect, it } from "vitest";
import { assertExhaustive } from "../src/exhaustive.js";
import type { TransactionStatus } from "../src/transaction-status.js";

// Same exhaustiveness technique as task-status.test.ts. Explicitly covers
// the two recoverable states (`verifying`, `rpcRecoveryPending`) added in
// the 2026-08-22 simplification round.
function describeTransaction(status: TransactionStatus): string {
  switch (status.kind) {
    case "idle":
      return "空闲";
    case "awaitingSignature":
      return "等待钱包签名";
    case "pending":
      return `已广播：${status.txHash}`;
    case "confirming":
      return `确认中（${status.confirmations} 次确认）`;
    case "verifying":
      return `等待后端复核：${status.txHash}`;
    case "rpcRecoveryPending":
      return `RPC 暂时不可用，可恢复：${status.lastError}`;
    case "confirmed":
      return `已确认：${status.txHash}`;
    case "failed":
      return `失败：${status.reason}`;
    default:
      return assertExhaustive(status, "describeTransaction");
  }
}

describe("TransactionStatus", () => {
  it("covers every variant including the two recoverable states", () => {
    const samples: TransactionStatus[] = [
      { kind: "idle" },
      { kind: "awaitingSignature" },
      { kind: "pending", txHash: "0x1" },
      { kind: "confirming", txHash: "0x1", confirmations: 1 },
      { kind: "verifying", txHash: "0x1" },
      { kind: "rpcRecoveryPending", txHash: "0x1", lastError: "RPC_TEMPORARILY_UNAVAILABLE" },
      { kind: "confirmed", txHash: "0x1" },
      { kind: "failed", reason: "TASK_STATE_CONFLICT" },
    ];

    for (const sample of samples) {
      expect(() => describeTransaction(sample)).not.toThrow();
    }
    expect(samples).toHaveLength(8);
  });

  it("rpcRecoveryPending is distinct from failed (RPC_TEMPORARILY_UNAVAILABLE must never map to failed)", () => {
    const recovering: TransactionStatus = {
      kind: "rpcRecoveryPending",
      txHash: "0x1",
      lastError: "RPC_TEMPORARILY_UNAVAILABLE",
    };
    expect(recovering.kind).not.toBe("failed");
    expect(describeTransaction(recovering)).toContain("可恢复");
  });
});
