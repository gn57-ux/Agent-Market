import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { TASK_FUNDED_EVENT_ABI, type RawEventLog } from "./task-funded-event.js";
import { decodeFundedEventsFromLogs, shouldRollbackForReorg } from "./event-sync.js";

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
