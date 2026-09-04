import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeTaskAcceptedLog,
  findTaskAcceptedLog,
  TASK_ACCEPTED_EVENT_ABI,
} from "./task-accepted-event.js";
import type { RawEventLog } from "./task-funded-event.js";

const TASK_ESCROW_ADDRESS = "0x111111111111111111111111111111111111111a";
const AGENT_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID_ON_CHAIN = keccak256(toHex("task-1"));
const STAKE = 12_500_000_000_000_000_000n;

/**
 * Builds a real, ABI-encoded `TaskAccepted` log the same way viem's
 * `decodeEventLog` (used by `decodeTaskAcceptedLog`) expects to consume
 * one — mirrors `task-funded-event.test.ts`'s `buildTaskFundedLog`: not a
 * hand-typed string fixture, so a bug in the hand-written ABI fragment in
 * task-accepted-event.ts could not slip past these tests unnoticed.
 */
function buildTaskAcceptedLog(overrides: {
  address?: string;
  taskId?: `0x${string}`;
  agent?: `0x${string}`;
  stake?: bigint;
  logIndex?: number;
}): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const agent = overrides.agent ?? AGENT_ADDRESS;
  const stake = overrides.stake ?? STAKE;

  const topics = encodeEventTopics({
    abi: TASK_ACCEPTED_EVENT_ABI,
    eventName: "TaskAccepted",
    args: { taskId, agent: getAddress(agent) },
  }) as readonly string[];

  const data = encodeAbiParameters([{ name: "stake", type: "uint256" }], [stake]);

  return {
    address: overrides.address ?? TASK_ESCROW_ADDRESS,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

/** A real, ABI-encoded ERC-20 `Transfer(address,address,uint256)` log —
 * used to prove `findTaskAcceptedLog` actually skips non-matching logs
 * rather than happening to only ever be tested with TaskAccepted logs. */
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
    args: { from: getAddress(AGENT_ADDRESS), to: getAddress(TASK_ESCROW_ADDRESS) },
  }) as readonly string[];

  const data = encodeAbiParameters([{ name: "value", type: "uint256" }], [1_000n]);

  return {
    address: overrides.address ?? TOKEN_ADDRESS,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeTaskAcceptedLog", () => {
  it("decodes a real, ABI-encoded TaskAccepted log", () => {
    const log = buildTaskAcceptedLog({});
    const decoded = decodeTaskAcceptedLog(log);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(decoded?.agent.toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    expect(decoded?.stake).toBe(STAKE);
  });

  it("returns null (not a throw) for a log whose topics don't match the TaskAccepted signature", () => {
    const log = buildErc20TransferLog();
    expect(decodeTaskAcceptedLog(log)).toBeNull();
  });

  it("returns null for a log with an unrecognizable/garbage signature topic", () => {
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics: [pad(toHex(0), { size: 32 })],
      data: "0x",
      logIndex: 0,
    };
    expect(decodeTaskAcceptedLog(log)).toBeNull();
  });

  it("returns null when data can't be decoded against the expected non-indexed params", () => {
    const topics = encodeEventTopics({
      abi: TASK_ACCEPTED_EVENT_ABI,
      eventName: "TaskAccepted",
      args: { taskId: TASK_ID_ON_CHAIN, agent: getAddress(AGENT_ADDRESS) },
    }) as readonly string[];
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics,
      data: "0x1234", // too short / malformed for (uint256)
      logIndex: 0,
    };
    expect(decodeTaskAcceptedLog(log)).toBeNull();
  });
});

describe("findTaskAcceptedLog", () => {
  it("finds the TaskAccepted log emitted by trustedAddress, skipping a Transfer log from another contract", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS, logIndex: 0 });
    const acceptedLog = buildTaskAcceptedLog({ address: TASK_ESCROW_ADDRESS, logIndex: 1 });

    const decoded = findTaskAcceptedLog([transferLog, acceptedLog], TASK_ESCROW_ADDRESS);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
  });

  it("is case-insensitive when matching the trusted address", () => {
    const acceptedLog = buildTaskAcceptedLog({
      address: TASK_ESCROW_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    const decoded = findTaskAcceptedLog([acceptedLog], TASK_ESCROW_ADDRESS.toLowerCase());
    expect(decoded).not.toBeNull();
  });

  it("skips a TaskAccepted-shaped log emitted from an untrusted address", () => {
    const otherAddress = "0x999999999999999999999999999999999999999b";
    const acceptedLogFromWrongAddress = buildTaskAcceptedLog({ address: otherAddress });

    const decoded = findTaskAcceptedLog([acceptedLogFromWrongAddress], TASK_ESCROW_ADDRESS);
    expect(decoded).toBeNull();
  });

  it("returns null when no log matches", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS });
    expect(findTaskAcceptedLog([transferLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });
});
