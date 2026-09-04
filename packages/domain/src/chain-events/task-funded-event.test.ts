import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeTaskFundedLog,
  findTaskFundedLog,
  TASK_FUNDED_EVENT_ABI,
  type RawEventLog,
} from "./task-funded-event.js";

const TASK_ESCROW_ADDRESS = "0x111111111111111111111111111111111111111a";
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID_ON_CHAIN = keccak256(toHex("task-1"));
const BUDGET = 123_456_789_000_000_000_000n;
const DELIVERY_DEADLINE = 1_893_456_000n; // some future unix seconds

/**
 * Builds a real, ABI-encoded `TaskFunded` log the same way viem's
 * `decodeEventLog` (used by `decodeTaskFundedLog`) expects to consume one —
 * indexed args go into `topics` (after the event signature topic),
 * non-indexed args are ABI-encoded into `data`. This is deliberately NOT a
 * hand-typed string fixture: if it didn't round-trip through real ABI
 * encoding, a bug in the hand-written ABI fragment in task-funded-event.ts
 * could slip past these tests unnoticed.
 */
function buildTaskFundedLog(overrides: {
  address?: string;
  taskId?: `0x${string}`;
  requester?: `0x${string}`;
  token?: `0x${string}`;
  budget?: bigint;
  deliveryDeadline?: bigint;
  logIndex?: number;
}): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const requester = overrides.requester ?? REQUESTER_ADDRESS;
  const token = overrides.token ?? TOKEN_ADDRESS;
  const budget = overrides.budget ?? BUDGET;
  const deliveryDeadline = overrides.deliveryDeadline ?? DELIVERY_DEADLINE;

  const topics = encodeEventTopics({
    abi: TASK_FUNDED_EVENT_ABI,
    eventName: "TaskFunded",
    args: { taskId, requester: getAddress(requester) },
  }) as readonly string[];

  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "deliveryDeadline", type: "uint64" },
    ],
    [getAddress(token), budget, deliveryDeadline],
  );

  return {
    address: overrides.address ?? TASK_ESCROW_ADDRESS,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

/** A real, ABI-encoded ERC-20 `Transfer(address,address,uint256)` log —
 * used to prove `findTaskFundedLog` actually skips non-matching logs rather
 * than happening to only ever be tested with TaskFunded logs. */
function buildErc20TransferLog(
  overrides: { address?: string; logIndex?: number } = {},
): RawEventLog {
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
    args: { from: getAddress(REQUESTER_ADDRESS), to: getAddress(TASK_ESCROW_ADDRESS) },
  }) as readonly string[];

  const data = encodeAbiParameters([{ name: "value", type: "uint256" }], [1_000n]);

  return {
    address: overrides.address ?? TOKEN_ADDRESS,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeTaskFundedLog", () => {
  it("decodes a real, ABI-encoded TaskFunded log", () => {
    const log = buildTaskFundedLog({});
    const decoded = decodeTaskFundedLog(log);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(decoded?.requester.toLowerCase()).toBe(REQUESTER_ADDRESS.toLowerCase());
    expect(decoded?.token.toLowerCase()).toBe(TOKEN_ADDRESS.toLowerCase());
    expect(decoded?.budget).toBe(BUDGET);
    expect(decoded?.deliveryDeadline).toBe(DELIVERY_DEADLINE);
  });

  it("returns null (not a throw) for a log whose topics don't match the TaskFunded signature", () => {
    const log = buildErc20TransferLog();
    expect(decodeTaskFundedLog(log)).toBeNull();
  });

  it("returns null for a log with an unrecognizable/garbage signature topic", () => {
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics: [pad(toHex(0), { size: 32 })],
      data: "0x",
      logIndex: 0,
    };
    expect(decodeTaskFundedLog(log)).toBeNull();
  });

  it("returns null when data can't be decoded against the expected non-indexed params", () => {
    const topics = encodeEventTopics({
      abi: TASK_FUNDED_EVENT_ABI,
      eventName: "TaskFunded",
      args: { taskId: TASK_ID_ON_CHAIN, requester: getAddress(REQUESTER_ADDRESS) },
    }) as readonly string[];
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics,
      data: "0x1234", // too short / malformed for (address, uint256, uint64)
      logIndex: 0,
    };
    expect(decodeTaskFundedLog(log)).toBeNull();
  });
});

describe("findTaskFundedLog", () => {
  it("finds the TaskFunded log emitted by trustedAddress, skipping a Transfer log from another contract", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS, logIndex: 0 });
    const fundedLog = buildTaskFundedLog({ address: TASK_ESCROW_ADDRESS, logIndex: 1 });

    const decoded = findTaskFundedLog([transferLog, fundedLog], TASK_ESCROW_ADDRESS);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
  });

  it("is case-insensitive when matching the trusted address", () => {
    const fundedLog = buildTaskFundedLog({
      address: TASK_ESCROW_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    const decoded = findTaskFundedLog([fundedLog], TASK_ESCROW_ADDRESS.toLowerCase());
    expect(decoded).not.toBeNull();
  });

  it("skips a TaskFunded-shaped log emitted from an untrusted address", () => {
    const otherAddress = "0x999999999999999999999999999999999999999b";
    const fundedLogFromWrongAddress = buildTaskFundedLog({ address: otherAddress });

    const decoded = findTaskFundedLog([fundedLogFromWrongAddress], TASK_ESCROW_ADDRESS);
    expect(decoded).toBeNull();
  });

  it("returns null when no log matches", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS });
    expect(findTaskFundedLog([transferLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });
});
