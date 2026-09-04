import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeDisputeResolvedLog,
  findDisputeResolvedLog,
  DISPUTE_RESOLVED_EVENT_ABI,
} from "./dispute-resolved-event.js";
import type { RawEventLog } from "./task-funded-event.js";

const TASK_ESCROW_ADDRESS = "0x111111111111111111111111111111111111111a";
const ARBITRATOR_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID_ON_CHAIN = keccak256(toHex("task-1"));

function buildDisputeResolvedLog(overrides: {
  address?: string;
  taskId?: `0x${string}`;
  supportAgent?: boolean;
  logIndex?: number;
}): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const supportAgent = overrides.supportAgent ?? true;

  const topics = encodeEventTopics({
    abi: DISPUTE_RESOLVED_EVENT_ABI,
    eventName: "DisputeResolved",
    args: { taskId },
  }) as readonly string[];

  const data = encodeAbiParameters([{ name: "supportAgent", type: "bool" }], [supportAgent]);

  return {
    address: overrides.address ?? TASK_ESCROW_ADDRESS,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

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
    args: { from: getAddress(ARBITRATOR_ADDRESS), to: getAddress(TASK_ESCROW_ADDRESS) },
  }) as readonly string[];

  const data = encodeAbiParameters([{ name: "value", type: "uint256" }], [1_000n]);

  return {
    address: overrides.address ?? TOKEN_ADDRESS,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

describe("decodeDisputeResolvedLog", () => {
  it("decodes a real, ABI-encoded DisputeResolved log with supportAgent = true", () => {
    const decoded = decodeDisputeResolvedLog(buildDisputeResolvedLog({ supportAgent: true }));
    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(decoded?.supportAgent).toBe(true);
  });

  it("decodes a real, ABI-encoded DisputeResolved log with supportAgent = false", () => {
    const decoded = decodeDisputeResolvedLog(buildDisputeResolvedLog({ supportAgent: false }));
    expect(decoded).not.toBeNull();
    expect(decoded?.supportAgent).toBe(false);
  });

  it("returns null (not a throw) for a log whose topics don't match the DisputeResolved signature", () => {
    expect(decodeDisputeResolvedLog(buildErc20TransferLog())).toBeNull();
  });

  it("returns null for a log with an unrecognizable/garbage signature topic", () => {
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics: [pad(toHex(0), { size: 32 })],
      data: "0x",
      logIndex: 0,
    };
    expect(decodeDisputeResolvedLog(log)).toBeNull();
  });

  it("returns null when data can't be decoded against the expected non-indexed params", () => {
    const topics = encodeEventTopics({
      abi: DISPUTE_RESOLVED_EVENT_ABI,
      eventName: "DisputeResolved",
      args: { taskId: TASK_ID_ON_CHAIN },
    }) as readonly string[];
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics,
      data: "0x1234",
      logIndex: 0,
    };
    expect(decodeDisputeResolvedLog(log)).toBeNull();
  });
});

describe("findDisputeResolvedLog", () => {
  it("finds the DisputeResolved log emitted by trustedAddress, skipping a Transfer log from another contract", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS, logIndex: 0 });
    const resolvedLog = buildDisputeResolvedLog({ address: TASK_ESCROW_ADDRESS, logIndex: 1 });

    const decoded = findDisputeResolvedLog([transferLog, resolvedLog], TASK_ESCROW_ADDRESS);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
  });

  it("is case-insensitive when matching the trusted address", () => {
    const resolvedLog = buildDisputeResolvedLog({
      address: TASK_ESCROW_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    const decoded = findDisputeResolvedLog([resolvedLog], TASK_ESCROW_ADDRESS.toLowerCase());
    expect(decoded).not.toBeNull();
  });

  it("skips a DisputeResolved-shaped log emitted from an untrusted address", () => {
    const otherAddress = "0x999999999999999999999999999999999999999b";
    const wrongAddressLog = buildDisputeResolvedLog({ address: otherAddress });

    expect(findDisputeResolvedLog([wrongAddressLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });

  it("returns null when no log matches", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS });
    expect(findDisputeResolvedLog([transferLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });
});
