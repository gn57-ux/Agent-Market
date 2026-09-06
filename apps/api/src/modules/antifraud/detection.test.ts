import { describe, expect, it } from "vitest";
import {
  detectScoreManipulation,
  DEFAULT_SCORE_MANIPULATION_CONFIG,
  type RatingCandidate,
  detectFakeDelivery,
  DEFAULT_FAKE_DELIVERY_CONFIG,
  type DeliveryHashRecord,
  detectCollusion,
  DEFAULT_COLLUSION_CONFIG,
  type CollusionCandidate,
} from "./detection.js";

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function rating(overrides: Partial<RatingCandidate> & { id: string }): RatingCandidate {
  return {
    ratingId: overrides.id,
    agentId: overrides.agentId ?? "agent-1",
    requesterAddress: overrides.requesterAddress ?? `0x${overrides.id.padStart(40, "0")}`,
    score: overrides.score ?? 5,
    ratedAt: overrides.ratedAt ?? new Date(BASE_TIME),
    requesterCreatedAt: overrides.requesterCreatedAt ?? new Date(BASE_TIME - DAY),
  };
}

describe("detectScoreManipulation (F-2006/T-2005)", () => {
  it("flags an Agent with 3+ distinct new-account 5-star ratings within 24h", () => {
    const candidates = [
      rating({ id: "r1", requesterAddress: "0xaaa1", ratedAt: new Date(BASE_TIME) }),
      rating({ id: "r2", requesterAddress: "0xaaa2", ratedAt: new Date(BASE_TIME + 1 * HOUR) }),
      rating({ id: "r3", requesterAddress: "0xaaa3", ratedAt: new Date(BASE_TIME + 2 * HOUR) }),
    ];

    const signals = detectScoreManipulation(candidates);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.agentId).toBe("agent-1");
    expect(signals[0]?.evidence.requesterAddresses.sort()).toEqual(["0xaaa1", "0xaaa2", "0xaaa3"]);
    expect(signals[0]?.evidence.ratingIds.sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("does not flag when the qualifying ratings are spread beyond the suspicious window", () => {
    const candidates = [
      rating({ id: "r1", requesterAddress: "0xaaa1", ratedAt: new Date(BASE_TIME) }),
      rating({ id: "r2", requesterAddress: "0xaaa2", ratedAt: new Date(BASE_TIME + 30 * HOUR) }),
      rating({ id: "r3", requesterAddress: "0xaaa3", ratedAt: new Date(BASE_TIME + 60 * HOUR) }),
    ];

    expect(detectScoreManipulation(candidates)).toEqual([]);
  });

  it("does not count the SAME requester address more than once toward the threshold", () => {
    const candidates = [
      rating({ id: "r1", requesterAddress: "0xaaa1", ratedAt: new Date(BASE_TIME) }),
      rating({ id: "r2", requesterAddress: "0xaaa1", ratedAt: new Date(BASE_TIME + 1 * HOUR) }),
      rating({ id: "r3", requesterAddress: "0xaaa1", ratedAt: new Date(BASE_TIME + 2 * HOUR) }),
    ];

    expect(detectScoreManipulation(candidates)).toEqual([]);
  });

  it("does not flag ratings from requesters who are NOT new accounts", () => {
    const candidates = [
      rating({
        id: "r1",
        requesterAddress: "0xaaa1",
        ratedAt: new Date(BASE_TIME),
        requesterCreatedAt: new Date(BASE_TIME - 30 * DAY),
      }),
      rating({
        id: "r2",
        requesterAddress: "0xaaa2",
        ratedAt: new Date(BASE_TIME + 1 * HOUR),
        requesterCreatedAt: new Date(BASE_TIME - 30 * DAY),
      }),
      rating({
        id: "r3",
        requesterAddress: "0xaaa3",
        ratedAt: new Date(BASE_TIME + 2 * HOUR),
        requesterCreatedAt: new Date(BASE_TIME - 30 * DAY),
      }),
    ];

    expect(detectScoreManipulation(candidates)).toEqual([]);
  });

  it("does not flag ratings below the high-score threshold", () => {
    const candidates = [
      rating({ id: "r1", requesterAddress: "0xaaa1", score: 3 }),
      rating({ id: "r2", requesterAddress: "0xaaa2", score: 4 }),
      rating({ id: "r3", requesterAddress: "0xaaa3", score: 3 }),
    ];

    expect(detectScoreManipulation(candidates)).toEqual([]);
  });

  it("does not flag when the distinct-requester count is below the threshold", () => {
    const candidates = [
      rating({ id: "r1", requesterAddress: "0xaaa1" }),
      rating({ id: "r2", requesterAddress: "0xaaa2" }),
    ];

    expect(detectScoreManipulation(candidates)).toEqual([]);
  });

  it("evaluates multiple Agents independently, flagging only the one with a real pattern", () => {
    const candidates = [
      rating({ id: "r1", agentId: "agent-suspicious", requesterAddress: "0xaaa1" }),
      rating({
        id: "r2",
        agentId: "agent-suspicious",
        requesterAddress: "0xaaa2",
        ratedAt: new Date(BASE_TIME + 1 * HOUR),
      }),
      rating({
        id: "r3",
        agentId: "agent-suspicious",
        requesterAddress: "0xaaa3",
        ratedAt: new Date(BASE_TIME + 2 * HOUR),
      }),
      rating({ id: "r4", agentId: "agent-normal", requesterAddress: "0xbbb1" }),
    ];

    const signals = detectScoreManipulation(candidates);
    expect(signals.map((s) => s.agentId)).toEqual(["agent-suspicious"]);
  });

  it("respects a custom config (e.g. a lower distinct-requester threshold)", () => {
    const candidates = [
      rating({ id: "r1", requesterAddress: "0xaaa1" }),
      rating({ id: "r2", requesterAddress: "0xaaa2" }),
    ];

    const signals = detectScoreManipulation(candidates, {
      ...DEFAULT_SCORE_MANIPULATION_CONFIG,
      suspiciousRequesterCountThreshold: 2,
    });

    expect(signals).toHaveLength(1);
  });

  it("returns no signals for an empty candidate list", () => {
    expect(detectScoreManipulation([])).toEqual([]);
  });
});

function deliveryRecord(
  overrides: Partial<DeliveryHashRecord> & { id: string },
): DeliveryHashRecord {
  return {
    deliverableId: overrides.id,
    taskId: overrides.taskId ?? `task-${overrides.id}`,
    agentId: overrides.agentId ?? "agent-1",
    resultHash: overrides.resultHash ?? "0xhash1",
  };
}

describe("detectFakeDelivery (F-2007/T-2006)", () => {
  it("flags an Agent that submitted the SAME content hash for 2+ different tasks", () => {
    const records = [
      deliveryRecord({ id: "d1", taskId: "task-a", resultHash: "0xsame" }),
      deliveryRecord({ id: "d2", taskId: "task-b", resultHash: "0xsame" }),
    ];

    const signals = detectFakeDelivery(records);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.agentId).toBe("agent-1");
    expect(signals[0]?.evidence.duplicateGroups).toHaveLength(1);
    expect(signals[0]?.evidence.duplicateGroups[0]?.resultHash).toBe("0xsame");
    expect(signals[0]?.evidence.duplicateGroups[0]?.taskIds.sort()).toEqual(["task-a", "task-b"]);
    expect(signals[0]?.evidence.duplicateGroups[0]?.deliverableIds.sort()).toEqual(["d1", "d2"]);
  });

  it("N4 P1 fix: aggregates MULTIPLE distinct duplicate-hash clusters for the SAME Agent into ONE signal (never silently drops evidence)", () => {
    const records = [
      deliveryRecord({ id: "d1", taskId: "task-a", resultHash: "0xhash-one" }),
      deliveryRecord({ id: "d2", taskId: "task-b", resultHash: "0xhash-one" }),
      deliveryRecord({ id: "d3", taskId: "task-c", resultHash: "0xhash-two" }),
      deliveryRecord({ id: "d4", taskId: "task-d", resultHash: "0xhash-two" }),
    ];

    const signals = detectFakeDelivery(records);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.agentId).toBe("agent-1");
    expect(signals[0]?.evidence.duplicateGroups).toHaveLength(2);
    const hashes = signals[0]?.evidence.duplicateGroups.map((g) => g.resultHash).sort();
    expect(hashes).toEqual(["0xhash-one", "0xhash-two"]);
  });

  it("does not flag the same hash reused for the SAME task (resubmission, not duplication across tasks)", () => {
    const records = [
      deliveryRecord({ id: "d1", taskId: "task-a", resultHash: "0xsame" }),
      deliveryRecord({ id: "d2", taskId: "task-a", resultHash: "0xsame" }),
    ];

    expect(detectFakeDelivery(records)).toEqual([]);
  });

  it("does not flag different content hashes across different tasks", () => {
    const records = [
      deliveryRecord({ id: "d1", taskId: "task-a", resultHash: "0xone" }),
      deliveryRecord({ id: "d2", taskId: "task-b", resultHash: "0xtwo" }),
    ];

    expect(detectFakeDelivery(records)).toEqual([]);
  });

  it("does not flag the same hash reused by DIFFERENT Agents (each Agent's own reuse is independent)", () => {
    const records = [
      deliveryRecord({ id: "d1", taskId: "task-a", agentId: "agent-1", resultHash: "0xsame" }),
      deliveryRecord({ id: "d2", taskId: "task-b", agentId: "agent-2", resultHash: "0xsame" }),
    ];

    expect(detectFakeDelivery(records)).toEqual([]);
  });

  it("respects a custom config", () => {
    const records = [
      deliveryRecord({ id: "d1", taskId: "task-a", resultHash: "0xsame" }),
      deliveryRecord({ id: "d2", taskId: "task-b", resultHash: "0xsame" }),
      deliveryRecord({ id: "d3", taskId: "task-c", resultHash: "0xsame" }),
    ];

    expect(
      detectFakeDelivery(records, { ...DEFAULT_FAKE_DELIVERY_CONFIG, minDuplicateTaskCount: 3 }),
    ).toHaveLength(1);
    expect(
      detectFakeDelivery(records, { ...DEFAULT_FAKE_DELIVERY_CONFIG, minDuplicateTaskCount: 4 }),
    ).toEqual([]);
  });

  it("returns no signals for an empty record list", () => {
    expect(detectFakeDelivery([])).toEqual([]);
  });
});

function collusionCandidate(
  overrides: Partial<CollusionCandidate> & { id: string },
): CollusionCandidate {
  return {
    taskId: overrides.taskId ?? `task-${overrides.id}`,
    requesterAddress: overrides.requesterAddress ?? "0xrequester1",
    agentId: overrides.agentId ?? "agent-1",
    score: overrides.score ?? 5,
  };
}

describe("detectCollusion (F-2008/T-2006)", () => {
  it("flags a (requester, Agent) pair with 5+ distinct high-scored tasks", () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      collusionCandidate({ id: `c${i}`, taskId: `task-${i}` }),
    );

    const signals = detectCollusion(candidates);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.agentId).toBe("agent-1");
    expect(signals[0]?.evidence.suspiciousPairs).toHaveLength(1);
    expect(signals[0]?.evidence.suspiciousPairs[0]?.requesterAddress).toBe("0xrequester1");
    expect(signals[0]?.evidence.suspiciousPairs[0]?.taskIds).toHaveLength(5);
  });

  it("N4 P1 fix: aggregates MULTIPLE distinct suspicious requester pairs for the SAME Agent into ONE signal (never silently drops evidence)", () => {
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) =>
        collusionCandidate({
          id: `a${i}`,
          taskId: `task-a-${i}`,
          requesterAddress: "0xrequesterA",
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        collusionCandidate({
          id: `b${i}`,
          taskId: `task-b-${i}`,
          requesterAddress: "0xrequesterB",
        }),
      ),
    ];

    const signals = detectCollusion(candidates);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.agentId).toBe("agent-1");
    expect(signals[0]?.evidence.suspiciousPairs).toHaveLength(2);
    const requesters = signals[0]?.evidence.suspiciousPairs.map((p) => p.requesterAddress).sort();
    expect(requesters).toEqual(["0xrequesterA", "0xrequesterB"]);
  });

  it("does not flag when the pair's task count is below the threshold", () => {
    const candidates = Array.from({ length: 4 }, (_, i) =>
      collusionCandidate({ id: `c${i}`, taskId: `task-${i}` }),
    );

    expect(detectCollusion(candidates)).toEqual([]);
  });

  it("does not count low-scored tasks toward the threshold", () => {
    const candidates = [
      ...Array.from({ length: 4 }, (_, i) =>
        collusionCandidate({ id: `c${i}`, taskId: `task-${i}` }),
      ),
      collusionCandidate({ id: "c5", taskId: "task-5", score: 3 }),
    ];

    expect(detectCollusion(candidates)).toEqual([]);
  });

  it("evaluates each (requester, Agent) pair independently — spreading tasks across different Agents does not accumulate", () => {
    const candidates = [
      ...Array.from({ length: 3 }, (_, i) =>
        collusionCandidate({ id: `c${i}`, taskId: `task-a-${i}`, agentId: "agent-1" }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        collusionCandidate({ id: `d${i}`, taskId: `task-b-${i}`, agentId: "agent-2" }),
      ),
    ];

    expect(detectCollusion(candidates)).toEqual([]);
  });

  it("respects a custom config", () => {
    const candidates = Array.from({ length: 3 }, (_, i) =>
      collusionCandidate({ id: `c${i}`, taskId: `task-${i}` }),
    );

    const signals = detectCollusion(candidates, {
      ...DEFAULT_COLLUSION_CONFIG,
      minHighScoreTaskCount: 3,
    });

    expect(signals).toHaveLength(1);
  });

  it("returns no signals for an empty candidate list", () => {
    expect(detectCollusion([])).toEqual([]);
  });
});
