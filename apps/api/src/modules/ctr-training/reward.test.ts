import { describe, expect, it } from "vitest";
import { computeReward } from "./reward.js";
import type { TrainingExampleRow } from "./dataset-builder.js";

function baseExample(overrides: Partial<TrainingExampleRow> = {}): TrainingExampleRow {
  return {
    exposureEventId: "exposure-1",
    taskId: "task-1",
    agentId: "agent-1",
    runId: "run-1",
    algorithmVersion: "v0.2",
    taskTerminalStatus: "RELEASED",
    candidateFeatures: {
      score: 0.8,
      rank: 1,
      slotType: "TOP_SCORE",
      reputationSignals: null,
      semanticSimilarity: null,
    },
    wasAccepted: false,
    outcome: null,
    ...overrides,
  };
}

describe("computeReward", () => {
  it("is neutral (0) for a non-accepted (censored) candidate", () => {
    expect(computeReward(baseExample({ wasAccepted: false, outcome: null }))).toBe(0);
  });

  it("is +1 for an accepted candidate with no further outcome recorded", () => {
    expect(computeReward(baseExample({ wasAccepted: true, outcome: null }))).toBe(1);
  });

  it("adds +1 for an approved outcome", () => {
    const reward = computeReward(
      baseExample({
        wasAccepted: true,
        outcome: { approved: true, ratingScore: null, refunded: false, disputed: false },
      }),
    );
    expect(reward).toBe(2);
  });

  it("scales a rating score around a neutral 3", () => {
    const highRating = computeReward(
      baseExample({
        wasAccepted: true,
        outcome: { approved: true, ratingScore: 5, refunded: false, disputed: false },
      }),
    );
    // base 1 + approved 1 + (5-3)/2 = 1 -> 3
    expect(highRating).toBe(3);

    const lowRating = computeReward(
      baseExample({
        wasAccepted: true,
        outcome: { approved: true, ratingScore: 1, refunded: false, disputed: false },
      }),
    );
    // base 1 + approved 1 + (1-3)/2 = -1 -> 1
    expect(lowRating).toBe(1);
  });

  it("penalizes a refund heavily", () => {
    const reward = computeReward(
      baseExample({
        wasAccepted: true,
        outcome: { approved: false, ratingScore: null, refunded: true, disputed: false },
      }),
    );
    expect(reward).toBe(1 - 1.5);
  });

  it("penalizes a dispute heavily", () => {
    const reward = computeReward(
      baseExample({
        wasAccepted: true,
        outcome: { approved: false, ratingScore: null, refunded: false, disputed: true },
      }),
    );
    expect(reward).toBe(1 - 1.5);
  });

  it("applies a mild penalty for an accepted-but-cancelled task with no approval", () => {
    const reward = computeReward(
      baseExample({
        wasAccepted: true,
        taskTerminalStatus: "CANCELLED",
        outcome: { approved: false, ratingScore: null, refunded: false, disputed: false },
      }),
    );
    expect(reward).toBe(1 - 0.5);
  });

  it("does not double-penalize a cancelled task that was still somehow approved", () => {
    const reward = computeReward(
      baseExample({
        wasAccepted: true,
        taskTerminalStatus: "CANCELLED",
        outcome: { approved: true, ratingScore: null, refunded: false, disputed: false },
      }),
    );
    expect(reward).toBe(2);
  });
});
