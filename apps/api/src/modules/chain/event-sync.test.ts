import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { TASK_FUNDED_EVENT_ABI, type RawEventLog } from "./task-funded-event.js";
import { RESULT_APPROVED_EVENT_ABI } from "./result-approved-event.js";
import { DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI } from "./delivery-timeout-claimed-event.js";
import { REVIEW_TIMEOUT_FINALIZED_EVENT_ABI } from "./review-timeout-finalized-event.js";
import { DISPUTE_OPENED_EVENT_ABI } from "./dispute-opened-event.js";
import { DISPUTE_RESOLVED_EVENT_ABI } from "./dispute-resolved-event.js";
import {
  decodeDeliveryTimeoutClaimedEventsFromLogs,
  decodeDisputeOpenedEventsFromLogs,
  decodeDisputeResolvedEventsFromLogs,
  decodeFundedEventsFromLogs,
  decodeResultApprovedEventsFromLogs,
  decodeReviewTimeoutFinalizedEventsFromLogs,
  shouldRollbackForReorg,
} from "./event-sync.js";

const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a";
const OTHER_CONTRACT_ADDRESS = "0x222222222222222222222222222222222222222b";
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const OTHER_BLOCK_HASH = ("0x" + "c".repeat(64)) as `0x${string}`;

function buildTaskFundedLog(
  overrides: {
    address?: string;
    taskId?: `0x${string}`;
    logIndex?: number;
  } = {},
): RawEventLog {
  const taskId = overrides.taskId ?? (keccak256(toHex("task-1")) as `0x${string}`);

  const topics = encodeEventTopics({
    abi: TASK_FUNDED_EVENT_ABI,
    eventName: "TaskFunded",
    args: { taskId, requester: getAddress(REQUESTER_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "deliveryDeadline", type: "uint64" },
    ],
    [getAddress(TOKEN_ADDRESS), 1000n, 2_000_000_000n],
  );

  return {
    address: overrides.address ?? TRUSTED_CONTRACT,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

function buildErc20TransferLog(logIndex: number): RawEventLog {
  const transferAbi = [
    {
      type: "event",
      name: "Transfer",
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "value", type: "uint256", indexed: false },
      ],
    },
  ] as const;
  const topics = encodeEventTopics({
    abi: transferAbi,
    eventName: "Transfer",
    args: { from: getAddress(REQUESTER_ADDRESS), to: getAddress(TRUSTED_CONTRACT) },
  }) as readonly string[];
  const data = encodeAbiParameters([{ name: "value", type: "uint256" }], [1n]);
  return { address: TOKEN_ADDRESS, topics, data, logIndex };
}

describe("decodeFundedEventsFromLogs", () => {
  it("picks out only the TaskFunded logs from a mixed set, ignoring logs from other contracts", () => {
    const transferLog = buildErc20TransferLog(0);
    const fundedLog = buildTaskFundedLog({ logIndex: 1 });

    const results = decodeFundedEventsFromLogs([transferLog, fundedLog], TRUSTED_CONTRACT);

    expect(results).toHaveLength(1);
    expect(results[0]?.logIndex).toBe(1);
  });

  it("ignores a TaskFunded-shaped log emitted by an untrusted address", () => {
    const wrongAddressLog = buildTaskFundedLog({ address: OTHER_CONTRACT_ADDRESS });
    const results = decodeFundedEventsFromLogs([wrongAddressLog], TRUSTED_CONTRACT);
    expect(results).toHaveLength(0);
  });

  it("decodes multiple TaskFunded logs in the same receipt (does not assume only one)", () => {
    const taskIdA = keccak256(toHex("task-a"));
    const taskIdB = keccak256(toHex("task-b"));
    const logA = buildTaskFundedLog({ taskId: taskIdA, logIndex: 0 });
    const logB = buildTaskFundedLog({ taskId: taskIdB, logIndex: 1 });

    const results = decodeFundedEventsFromLogs([logA, logB], TRUSTED_CONTRACT);

    expect(results).toHaveLength(2);
    expect(results[0]?.event.taskId.toLowerCase()).toBe(taskIdA.toLowerCase());
    expect(results[1]?.event.taskId.toLowerCase()).toBe(taskIdB.toLowerCase());
  });

  it("returns an empty array when no logs decode as TaskFunded", () => {
    const results = decodeFundedEventsFromLogs([buildErc20TransferLog(0)], TRUSTED_CONTRACT);
    expect(results).toEqual([]);
  });
});

const AGENT_ADDRESS = "0x6683fefc63f0cd0e873a0000c6d07ef7b77e90d5";
const TASK_ID = keccak256(toHex("task-1"));
const SETTLEMENT_BUDGET = 1_000_000_000_000_000_000_000n;
const SETTLEMENT_STAKE = 60_000_000_000_000_000_000n;

function buildResultApprovedLog(
  overrides: { address?: string; logIndex?: number } = {},
): RawEventLog {
  const topics = encodeEventTopics({
    abi: RESULT_APPROVED_EVENT_ABI,
    eventName: "ResultApproved",
    args: { taskId: TASK_ID, agent: getAddress(AGENT_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [SETTLEMENT_BUDGET, SETTLEMENT_STAKE],
  );
  return {
    address: overrides.address ?? TRUSTED_CONTRACT,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeResultApprovedEventsFromLogs", () => {
  it("picks out only the ResultApproved logs from a mixed set, ignoring logs from other contracts", () => {
    const transferLog = buildErc20TransferLog(0);
    const approvedLog = buildResultApprovedLog({ logIndex: 1 });

    const results = decodeResultApprovedEventsFromLogs(
      [transferLog, approvedLog],
      TRUSTED_CONTRACT,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.logIndex).toBe(1);
  });

  it("ignores a ResultApproved-shaped log emitted by an untrusted address", () => {
    const wrongAddressLog = buildResultApprovedLog({ address: OTHER_CONTRACT_ADDRESS });
    expect(decodeResultApprovedEventsFromLogs([wrongAddressLog], TRUSTED_CONTRACT)).toHaveLength(0);
  });

  it("returns an empty array when no logs decode as ResultApproved", () => {
    const results = decodeResultApprovedEventsFromLogs(
      [buildErc20TransferLog(0)],
      TRUSTED_CONTRACT,
    );
    expect(results).toEqual([]);
  });
});

function buildDeliveryTimeoutClaimedLog(
  overrides: { address?: string; logIndex?: number } = {},
): RawEventLog {
  const topics = encodeEventTopics({
    abi: DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI,
    eventName: "DeliveryTimeoutClaimed",
    args: { taskId: TASK_ID, requester: getAddress(REQUESTER_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [SETTLEMENT_BUDGET, SETTLEMENT_STAKE],
  );
  return {
    address: overrides.address ?? TRUSTED_CONTRACT,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeDeliveryTimeoutClaimedEventsFromLogs", () => {
  it("picks out only the DeliveryTimeoutClaimed logs from a mixed set, ignoring logs from other contracts", () => {
    const transferLog = buildErc20TransferLog(0);
    const claimedLog = buildDeliveryTimeoutClaimedLog({ logIndex: 1 });

    const results = decodeDeliveryTimeoutClaimedEventsFromLogs(
      [transferLog, claimedLog],
      TRUSTED_CONTRACT,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.logIndex).toBe(1);
  });

  it("ignores a DeliveryTimeoutClaimed-shaped log emitted by an untrusted address", () => {
    const wrongAddressLog = buildDeliveryTimeoutClaimedLog({ address: OTHER_CONTRACT_ADDRESS });
    expect(
      decodeDeliveryTimeoutClaimedEventsFromLogs([wrongAddressLog], TRUSTED_CONTRACT),
    ).toHaveLength(0);
  });

  it("returns an empty array when no logs decode as DeliveryTimeoutClaimed", () => {
    const results = decodeDeliveryTimeoutClaimedEventsFromLogs(
      [buildErc20TransferLog(0)],
      TRUSTED_CONTRACT,
    );
    expect(results).toEqual([]);
  });
});

function buildReviewTimeoutFinalizedLog(
  overrides: { address?: string; logIndex?: number } = {},
): RawEventLog {
  const topics = encodeEventTopics({
    abi: REVIEW_TIMEOUT_FINALIZED_EVENT_ABI,
    eventName: "ReviewTimeoutFinalized",
    args: { taskId: TASK_ID, agent: getAddress(AGENT_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [SETTLEMENT_BUDGET, SETTLEMENT_STAKE],
  );
  return {
    address: overrides.address ?? TRUSTED_CONTRACT,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeReviewTimeoutFinalizedEventsFromLogs", () => {
  it("picks out only the ReviewTimeoutFinalized logs from a mixed set, ignoring logs from other contracts", () => {
    const transferLog = buildErc20TransferLog(0);
    const finalizedLog = buildReviewTimeoutFinalizedLog({ logIndex: 1 });

    const results = decodeReviewTimeoutFinalizedEventsFromLogs(
      [transferLog, finalizedLog],
      TRUSTED_CONTRACT,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.logIndex).toBe(1);
  });

  it("ignores a ReviewTimeoutFinalized-shaped log emitted by an untrusted address", () => {
    const wrongAddressLog = buildReviewTimeoutFinalizedLog({ address: OTHER_CONTRACT_ADDRESS });
    expect(
      decodeReviewTimeoutFinalizedEventsFromLogs([wrongAddressLog], TRUSTED_CONTRACT),
    ).toHaveLength(0);
  });

  it("returns an empty array when no logs decode as ReviewTimeoutFinalized", () => {
    const results = decodeReviewTimeoutFinalizedEventsFromLogs(
      [buildErc20TransferLog(0)],
      TRUSTED_CONTRACT,
    );
    expect(results).toEqual([]);
  });
});

const EVIDENCE_HASH = keccak256(toHex("evidence content"));

function buildDisputeOpenedLog(
  overrides: { address?: string; logIndex?: number } = {},
): RawEventLog {
  const topics = encodeEventTopics({
    abi: DISPUTE_OPENED_EVENT_ABI,
    eventName: "DisputeOpened",
    args: { taskId: TASK_ID, requester: getAddress(REQUESTER_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [{ name: "disputeEvidenceHash", type: "bytes32" }],
    [EVIDENCE_HASH],
  );
  return {
    address: overrides.address ?? TRUSTED_CONTRACT,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeDisputeOpenedEventsFromLogs", () => {
  it("picks out only the DisputeOpened logs from a mixed set, ignoring logs from other contracts", () => {
    const transferLog = buildErc20TransferLog(0);
    const openedLog = buildDisputeOpenedLog({ logIndex: 1 });

    const results = decodeDisputeOpenedEventsFromLogs([transferLog, openedLog], TRUSTED_CONTRACT);

    expect(results).toHaveLength(1);
    expect(results[0]?.logIndex).toBe(1);
  });

  it("ignores a DisputeOpened-shaped log emitted by an untrusted address", () => {
    const wrongAddressLog = buildDisputeOpenedLog({ address: OTHER_CONTRACT_ADDRESS });
    expect(decodeDisputeOpenedEventsFromLogs([wrongAddressLog], TRUSTED_CONTRACT)).toHaveLength(0);
  });

  it("returns an empty array when no logs decode as DisputeOpened", () => {
    const results = decodeDisputeOpenedEventsFromLogs([buildErc20TransferLog(0)], TRUSTED_CONTRACT);
    expect(results).toEqual([]);
  });
});

function buildDisputeResolvedLog(
  overrides: { address?: string; supportAgent?: boolean; logIndex?: number } = {},
): RawEventLog {
  const topics = encodeEventTopics({
    abi: DISPUTE_RESOLVED_EVENT_ABI,
    eventName: "DisputeResolved",
    args: { taskId: TASK_ID },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [{ name: "supportAgent", type: "bool" }],
    [overrides.supportAgent ?? true],
  );
  return {
    address: overrides.address ?? TRUSTED_CONTRACT,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeDisputeResolvedEventsFromLogs", () => {
  it("picks out only the DisputeResolved logs from a mixed set, ignoring logs from other contracts", () => {
    const transferLog = buildErc20TransferLog(0);
    const resolvedLog = buildDisputeResolvedLog({ logIndex: 1 });

    const results = decodeDisputeResolvedEventsFromLogs(
      [transferLog, resolvedLog],
      TRUSTED_CONTRACT,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.logIndex).toBe(1);
  });

  it("ignores a DisputeResolved-shaped log emitted by an untrusted address", () => {
    const wrongAddressLog = buildDisputeResolvedLog({ address: OTHER_CONTRACT_ADDRESS });
    expect(decodeDisputeResolvedEventsFromLogs([wrongAddressLog], TRUSTED_CONTRACT)).toHaveLength(
      0,
    );
  });

  it("returns an empty array when no logs decode as DisputeResolved", () => {
    const results = decodeDisputeResolvedEventsFromLogs(
      [buildErc20TransferLog(0)],
      TRUSTED_CONTRACT,
    );
    expect(results).toEqual([]);
  });
});

describe("shouldRollbackForReorg", () => {
  const projection = { blockNumber: 100n, blockHash: BLOCK_HASH };

  it("returns false when the canonical block's hash matches the projection's blockHash", () => {
    expect(shouldRollbackForReorg(projection, { hash: BLOCK_HASH, number: 100n })).toBe(false);
  });

  it("returns true when the canonical block's hash differs (a real reorg)", () => {
    expect(shouldRollbackForReorg(projection, { hash: OTHER_BLOCK_HASH, number: 100n })).toBe(true);
  });

  it("is case-insensitive when comparing block hashes", () => {
    expect(
      shouldRollbackForReorg(projection, {
        hash: BLOCK_HASH.toUpperCase() as `0x${string}`,
        number: 100n,
      }),
    ).toBe(false);
  });

  it("returns true when canonicalBlock is null (RPC no longer resolves any block at that height)", () => {
    expect(shouldRollbackForReorg(projection, null)).toBe(true);
  });

  it("returns true (caller-error guard) when canonicalBlock is at a different height than the projection", () => {
    expect(shouldRollbackForReorg(projection, { hash: BLOCK_HASH, number: 101n })).toBe(true);
  });
});
