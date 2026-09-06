import { describe, expect, it } from "vitest";
import {
  enumerateWeightGrid,
  evaluateAgainstProduction,
  evaluateStoredCandidateAgainstCurrentProduction,
  evaluateWeights,
  splitByTask,
  trainModel,
  type TrainModelOptions,
  type UsableExample,
} from "./model-trainer.js";
import { DEFAULT_FUSION_WEIGHTS } from "./fusion-weights.js";
import type { TrainingExampleRow } from "./dataset-builder.js";
import type { ReputationSignalsDigest } from "../dispatch/reputation-signals.js";

function entry(value: number | null): { value: number | null; sampleSize: number } {
  return { value, sampleSize: value === null ? 0 : 5 };
}

function signals(
  partial: Partial<Record<keyof ReputationSignalsDigest, number>>,
): ReputationSignalsDigest {
  return {
    completionRate: entry(partial.completionRate ?? null),
    qualityFeedback: entry(partial.qualityFeedback ?? null),
    communication: entry(partial.communication ?? null),
    disputeSignal: entry(partial.disputeSignal ?? null),
    historicalScale: entry(partial.historicalScale ?? null),
  };
}

function example(
  taskId: string,
  reputationSignals: ReputationSignalsDigest | null,
  overrides: Partial<TrainingExampleRow> = {},
): TrainingExampleRow {
  return {
    exposureEventId: `exp-${taskId}-${Math.random()}`,
    taskId,
    agentId: `agent-${taskId}-${Math.random()}`,
    runId: `run-${taskId}`,
    algorithmVersion: "v0.2",
    taskTerminalStatus: "RELEASED",
    candidateFeatures: {
      score: 0.5,
      rank: 1,
      slotType: "TOP_SCORE",
      reputationSignals,
      semanticSimilarity: null,
    },
    wasAccepted: false,
    outcome: null,
    ...overrides,
  };
}

/** An ACCEPTED candidate whose reward is driven by `ratingScore` (1-5) —
 * the only usable outcome signal that varies continuously, letting tests
 * build datasets where reward correlates with a specific reputation
 * signal without also needing refund/dispute/cancellation combinations. */
function acceptedExample(
  taskId: string,
  reputationSignals: ReputationSignalsDigest,
  ratingScore: number,
): TrainingExampleRow {
  return example(taskId, reputationSignals, {
    wasAccepted: true,
    outcome: { approved: true, ratingScore, refunded: false, disputed: false },
  });
}

describe("enumerateWeightGrid", () => {
  it("only produces weight vectors that sum to 1 (within floating tolerance)", () => {
    const grid = enumerateWeightGrid(20);
    for (const weights of grid) {
      const sum =
        weights.completionRate +
        weights.qualityFeedback +
        weights.communication +
        weights.disputeSignal +
        weights.historicalScale;
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it("includes Go's exact default weights as one grid point at totalUnits=20", () => {
    const grid = enumerateWeightGrid(20);
    const hasDefault = grid.some(
      (w) =>
        w.completionRate === DEFAULT_FUSION_WEIGHTS.completionRate &&
        w.qualityFeedback === DEFAULT_FUSION_WEIGHTS.qualityFeedback &&
        w.communication === DEFAULT_FUSION_WEIGHTS.communication &&
        w.disputeSignal === DEFAULT_FUSION_WEIGHTS.disputeSignal &&
        w.historicalScale === DEFAULT_FUSION_WEIGHTS.historicalScale,
    );
    expect(hasDefault).toBe(true);
  });

  it("produces exactly C(totalUnits+4, 4) compositions", () => {
    const totalUnits = 6;
    const grid = enumerateWeightGrid(totalUnits);
    expect(grid.length).toBe(210); // C(10,4) = 210
  });
});

describe("evaluateWeights", () => {
  it("skips pairs with equal reward (no ground-truth ordering)", () => {
    const examples: UsableExample[] = [
      { taskId: "task-a", reward: 1, signals: signals({ completionRate: 1 }) },
      { taskId: "task-b", reward: 1, signals: signals({ completionRate: 0 }) },
    ];
    const result = evaluateWeights(examples, DEFAULT_FUSION_WEIGHTS);
    expect(result.totalPairs).toBe(0);
  });

  it("forms pairs ACROSS tasks (each task has at most one accepted/usable candidate)", () => {
    const examples: UsableExample[] = [
      { taskId: "task-a", reward: 2, signals: signals({ completionRate: 1 }) },
      { taskId: "task-b", reward: 0, signals: signals({ completionRate: 0 }) },
    ];
    const result = evaluateWeights(examples, DEFAULT_FUSION_WEIGHTS);
    expect(result.totalPairs).toBe(1);
    expect(result.concordantPairs).toBe(1);
    expect(result.concordance).toBe(1);
  });

  it("counts a pair as discordant when the higher-reward candidate scores lower", () => {
    const examples: UsableExample[] = [
      { taskId: "task-a", reward: 2, signals: signals({ completionRate: 0 }) },
      { taskId: "task-b", reward: 0, signals: signals({ completionRate: 1 }) },
    ];
    const result = evaluateWeights(examples, DEFAULT_FUSION_WEIGHTS);
    expect(result.totalPairs).toBe(1);
    expect(result.concordantPairs).toBe(0);
    expect(result.concordance).toBe(0);
  });
});

describe("splitByTask", () => {
  it("is deterministic: the same input always produces the same split", () => {
    const examples: UsableExample[] = Array.from({ length: 12 }, (_, i) => ({
      taskId: `task-${i}`,
      reward: i,
      signals: signals({ completionRate: i / 12 }),
    }));
    const first = splitByTask(examples);
    const second = splitByTask(examples);
    expect(first.validation.map((e) => e.taskId)).toEqual(second.validation.map((e) => e.taskId));
    expect(first.train.map((e) => e.taskId)).toEqual(second.train.map((e) => e.taskId));
  });

  it("partitions every example into exactly one of train or validation", () => {
    const examples: UsableExample[] = Array.from({ length: 10 }, (_, i) => ({
      taskId: `task-${i}`,
      reward: i,
      signals: signals({ completionRate: i / 10 }),
    }));
    const { train, validation } = splitByTask(examples);
    expect(train.length + validation.length).toBe(examples.length);
    const trainIds = new Set(train.map((e) => e.taskId));
    const validationIds = new Set(validation.map((e) => e.taskId));
    for (const id of trainIds) expect(validationIds.has(id)).toBe(false);
  });
});

describe("trainModel", () => {
  it("excludes v0.1 examples (null reputationSignals) from usable training data", () => {
    const examples = [
      example("task-a", null, {
        wasAccepted: true,
        outcome: { approved: true, ratingScore: null, refunded: false, disputed: false },
      }),
    ];
    const result = trainModel(examples);
    expect(result.usableExampleCount).toBe(0);
    expect(result.pairCount).toBe(0);
    expect(result.sufficientData).toBe(false);
  });

  it("excludes non-accepted (censored) candidates entirely — never a positive or negative ground truth", () => {
    const examples = [
      // A censored candidate with a "better-looking" signal than the
      // accepted one — if censored rows leaked into training, this would
      // look like a discordant pair and drag down concordance.
      example("task-a", signals({ completionRate: 1 }), { wasAccepted: false }),
      acceptedExample("task-a", signals({ completionRate: 0 }), 5),
    ];
    const result = trainModel(examples);
    // Only ONE usable (accepted) example exists across all tasks — no pair
    // can be formed regardless of the censored row's signal values.
    expect(result.usableExampleCount).toBe(1);
    expect(result.pairCount).toBe(0);
  });

  it("reports insufficient data below the pair-count threshold and does not claim improvement", () => {
    const examples = [
      acceptedExample("task-a", signals({ completionRate: 1 }), 5),
      acceptedExample("task-b", signals({ completionRate: 0 }), 1),
    ];
    const result = trainModel(examples, { minPairCount: 30 } satisfies TrainModelOptions);
    expect(result.sufficientData).toBe(false);
    expect(result.improvedOverProduction).toBe(false);
  });

  it("finds a strictly better weight vector when the signal that predicts reward is discoverable on held-out data, given enough tasks", () => {
    const examples: TrainingExampleRow[] = [];
    // 90 tasks, each with exactly ONE accepted candidate. Reward (via
    // ratingScore) is driven by `communication`, not `completionRate` — the
    // reverse of Go's default weighting (completionRate=0.30 >
    // communication=0.15) — so default weights should rank these WORSE
    // than a candidate vector that favors `communication`. 90 tasks (not
    // 40) because only ~2/3 land in `train` and ~1/3 in `validation` after
    // `splitByTask`, and the promotion decision is measured on validation
    // alone.
    for (let i = 0; i < 90; i += 1) {
      const taskId = `task-${i}`;
      const communicationValue = i % 2 === 0 ? 1 : 0;
      const ratingScore = communicationValue === 1 ? 5 : 1;
      examples.push(
        acceptedExample(
          taskId,
          signals({ completionRate: 1 - communicationValue, communication: communicationValue }),
          ratingScore,
        ),
      );
    }

    const result = trainModel(examples, { minPairCount: 30 } satisfies TrainModelOptions);
    expect(result.sufficientData).toBe(true);
    expect(result.usableExampleCount).toBe(90);
    // Default weights favor completionRate (anti-correlated with reward
    // here), so they systematically rank the higher-reward candidate LOWER
    // on the held-out validation split.
    expect(result.productionConcordance).toBe(0);
    expect(result.candidateConcordance).toBe(1);
    expect(result.improvedOverProduction).toBe(true);
    expect(result.candidateWeights.communication).toBeGreaterThan(
      result.candidateWeights.completionRate,
    );
  });
});

describe("evaluateAgainstProduction / evaluateStoredCandidateAgainstCurrentProduction", () => {
  it("re-measures a stored candidate against a DIFFERENT current production baseline than it was trained against", () => {
    const examples: TrainingExampleRow[] = [];
    for (let i = 0; i < 90; i += 1) {
      const taskId = `task-${i}`;
      const communicationValue = i % 2 === 0 ? 1 : 0;
      const ratingScore = communicationValue === 1 ? 5 : 1;
      examples.push(
        acceptedExample(
          taskId,
          signals({ completionRate: 1 - communicationValue, communication: communicationValue }),
          ratingScore,
        ),
      );
    }

    const trained = trainModel(examples, { minPairCount: 30 });
    expect(trained.improvedOverProduction).toBe(true);

    // Re-validate the SAME stored candidate weights, but against a
    // "current production" that is itself already perfectly tuned to this
    // exact pattern — a real newer promotion that happened after this
    // candidate was trained (N4 real finding, P1, round 2's own scenario).
    // The candidate can no longer show an improvement over THIS baseline.
    const revalidation = evaluateStoredCandidateAgainstCurrentProduction(
      examples,
      trained.candidateWeights,
      trained.candidateWeights,
      30,
    );
    expect(revalidation.improvedOverProduction).toBe(false);
    expect(revalidation.candidateConcordance).toBe(revalidation.productionConcordance);
  });

  it("evaluateAgainstProduction only ever uses the examples explicitly passed to it (a validation split)", () => {
    const validation: UsableExample[] = [
      { taskId: "task-a", reward: 1, signals: signals({ completionRate: 1 }) },
      { taskId: "task-b", reward: 0, signals: signals({ completionRate: 0 }) },
    ];
    const result = evaluateAgainstProduction(
      validation,
      {
        ...DEFAULT_FUSION_WEIGHTS,
        completionRate: 1,
        qualityFeedback: 0,
        communication: 0,
        disputeSignal: 0,
        historicalScale: 0,
      },
      DEFAULT_FUSION_WEIGHTS,
      1,
    );
    expect(result.pairCount).toBe(1);
    expect(result.sufficientData).toBe(true);
  });
});
