import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeDisputeOpenedLog,
  findDisputeOpenedLog,
  DISPUTE_OPENED_EVENT_ABI,
} from "./dispute-opened-event.js";
import type { RawEventLog } from "./task-funded-event.js";

const TASK_ESCROW_ADDRESS = "0x111111111111111111111111111111111111111a";
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID_ON_CHAIN = keccak256(toHex("task-1"));
const EVIDENCE_HASH = keccak256(toHex("evidence content"));

function buildDisputeOpenedLog(overrides: {
  address?: string;
  taskId?: `0x${string}`;
  requester?: `0x${string}`;
  disputeEvidenceHash?: `0x${string}`;
  logIndex?: number;
}): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const requester = overrides.requester ?? REQUESTER_ADDRESS;
  const disputeEvidenceHash = overrides.disputeEvidenceHash ?? EVIDENCE_HASH;

  const topics = encodeEventTopics({
    abi: DISPUTE_OPENED_EVENT_ABI,
    eventName: "DisputeOpened",
    args: { taskId, requester: getAddress(requester) },
  }) as readonly string[];

  const data = encodeAbiParameters(
    [{ name: "disputeEvidenceHash", type: "bytes32" }],
    [disputeEvidenceHash],
  );

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

describe("decodeDisputeOpenedLog", () => {
  it("decodes a real, ABI-encoded DisputeOpened log", () => {
    const log = buildDisputeOpenedLog({});
    const decoded = decodeDisputeOpenedLog(log);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(decoded?.requester.toLowerCase()).toBe(REQUESTER_ADDRESS.toLowerCase());
    expect(decoded?.disputeEvidenceHash.toLowerCase()).toBe(EVIDENCE_HASH.toLowerCase());
  });

  it("returns null (not a throw) for a log whose topics don't match the DisputeOpened signature", () => {
    expect(decodeDisputeOpenedLog(buildErc20TransferLog())).toBeNull();
  });

  it("returns null for a log with an unrecognizable/garbage signature topic", () => {
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics: [pad(toHex(0), { size: 32 })],
      data: "0x",
      logIndex: 0,
    };
    expect(decodeDisputeOpenedLog(log)).toBeNull();
  });

  it("returns null when data can't be decoded against the expected non-indexed params", () => {
    const topics = encodeEventTopics({
      abi: DISPUTE_OPENED_EVENT_ABI,
      eventName: "DisputeOpened",
      args: { taskId: TASK_ID_ON_CHAIN, requester: getAddress(REQUESTER_ADDRESS) },
    }) as readonly string[];
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics,
      data: "0x1234",
      logIndex: 0,
    };
    expect(decodeDisputeOpenedLog(log)).toBeNull();
  });
});

describe("findDisputeOpenedLog", () => {
  it("finds the DisputeOpened log emitted by trustedAddress, skipping a Transfer log from another contract", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS, logIndex: 0 });
    const openedLog = buildDisputeOpenedLog({ address: TASK_ESCROW_ADDRESS, logIndex: 1 });

    const decoded = findDisputeOpenedLog([transferLog, openedLog], TASK_ESCROW_ADDRESS);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
  });

  it("is case-insensitive when matching the trusted address", () => {
    const openedLog = buildDisputeOpenedLog({
      address: TASK_ESCROW_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    const decoded = findDisputeOpenedLog([openedLog], TASK_ESCROW_ADDRESS.toLowerCase());
    expect(decoded).not.toBeNull();
  });

  it("skips a DisputeOpened-shaped log emitted from an untrusted address", () => {
    const otherAddress = "0x999999999999999999999999999999999999999b";
    const wrongAddressLog = buildDisputeOpenedLog({ address: otherAddress });

    expect(findDisputeOpenedLog([wrongAddressLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });

  it("returns null when no log matches", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS });
    expect(findDisputeOpenedLog([transferLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });
});
