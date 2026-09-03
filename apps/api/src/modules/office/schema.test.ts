import { describe, expect, it } from "vitest";
import { officeSnapshotSchema } from "./schema.js";

function minimumSnapshot() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-28T18:00:00.000Z",
    viewer: { address: "0x1234567890abcdef1234567890abcdef12345678" },
    agents: [],
    taskBoard: { published: [], accepted: [] },
    funds: { kind: "unavailable", reason: "RPC_UNAVAILABLE" },
    deliveryDesk: [],
    achievements: {
      completedTaskCount: 0,
      averageRating: null,
      qualityScore: null,
      overdueCount: 0,
      recentCompletedTasks: [],
    },
  };
}

describe("officeSnapshotSchema", () => {
  it("accepts an empty office and preserves unavailable chain state", () => {
    expect(officeSnapshotSchema.parse(minimumSnapshot()).funds).toEqual({
      kind: "unavailable",
      reason: "RPC_UNAVAILABLE",
    });
  });

  it("rejects precision-losing numeric balances", () => {
    const snapshot = minimumSnapshot();
    expect(() =>
      officeSnapshotSchema.parse({
        ...snapshot,
        funds: {
          kind: "available",
          tokenSymbol: "YD",
          decimals: 18,
          walletBalance: 10,
          lockedBudget: "0",
          agentStake: "0",
          pendingSettlement: "0",
          observedBlockNumber: "1",
        },
      }),
    ).toThrow();
  });
});
