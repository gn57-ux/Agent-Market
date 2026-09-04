import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeDeliveryTimeoutClaimedLog,
  findDeliveryTimeoutClaimedLog,
  DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI,
} from "./delivery-timeout-claimed-event.js";
import type { RawEventLog } from "./task-funded-event.js";

const TASK_ESCROW_ADDRESS = "0x111111111111111111111111111111111111111a";
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID_ON_CHAIN = keccak256(toHex("task-1"));
const BUDGET = 1_000_000_000_000_000_000_000n;
const STAKE = 60_000_000_000_000_000_000n;

function buildDeliveryTimeoutClaimedLog(overrides: {
  address?: string;
  taskId?: `0x${string}`;
  requester?: `0x${string}`;
  budget?: bigint;
  stake?: bigint;
  logIndex?: number;
}): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const requester = overrides.requester ?? REQUESTER_ADDRESS;
  const budget = overrides.budget ?? BUDGET;
  const stake = overrides.stake ?? STAKE;

  const topics = encodeEventTopics({
    abi: DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI,
    eventName: "DeliveryTimeoutClaimed",
    args: { taskId, requester: getAddress(requester) },
  }) as readonly string[];

  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [budget, stake],
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

describe("decodeDeliveryTimeoutClaimedLog", () => {
  it("decodes a real, ABI-encoded DeliveryTimeoutClaimed log", () => {
    const log = buildDeliveryTimeoutClaimedLog({});
    const decoded = decodeDeliveryTimeoutClaimedLog(log);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(decoded?.requester.toLowerCase()).toBe(REQUESTER_ADDRESS.toLowerCase());
    expect(decoded?.budget).toBe(BUDGET);
    expect(decoded?.stake).toBe(STAKE);
  });

  it("returns null (not a throw) for a log whose topics don't match the DeliveryTimeoutClaimed signature", () => {
    const log = buildErc20TransferLog();
    expect(decodeDeliveryTimeoutClaimedLog(log)).toBeNull();
  });

  it("returns null for a log with an unrecognizable/garbage signature topic", () => {
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics: [pad(toHex(0), { size: 32 })],
      data: "0x",
      logIndex: 0,
    };
    expect(decodeDeliveryTimeoutClaimedLog(log)).toBeNull();
  });

  it("returns null when data can't be decoded against the expected non-indexed params", () => {
    const topics = encodeEventTopics({
      abi: DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI,
      eventName: "DeliveryTimeoutClaimed",
      args: { taskId: TASK_ID_ON_CHAIN, requester: getAddress(REQUESTER_ADDRESS) },
    }) as readonly string[];
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics,
      data: "0x1234",
      logIndex: 0,
    };
    expect(decodeDeliveryTimeoutClaimedLog(log)).toBeNull();
  });
});

describe("findDeliveryTimeoutClaimedLog", () => {
  it("finds the DeliveryTimeoutClaimed log emitted by trustedAddress, skipping a Transfer log from another contract", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS, logIndex: 0 });
    const claimedLog = buildDeliveryTimeoutClaimedLog({
      address: TASK_ESCROW_ADDRESS,
      logIndex: 1,
    });

    const decoded = findDeliveryTimeoutClaimedLog([transferLog, claimedLog], TASK_ESCROW_ADDRESS);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
  });

  it("is case-insensitive when matching the trusted address", () => {
    const claimedLog = buildDeliveryTimeoutClaimedLog({
      address: TASK_ESCROW_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    const decoded = findDeliveryTimeoutClaimedLog([claimedLog], TASK_ESCROW_ADDRESS.toLowerCase());
    expect(decoded).not.toBeNull();
  });

  it("skips a DeliveryTimeoutClaimed-shaped log emitted from an untrusted address", () => {
    const otherAddress = "0x999999999999999999999999999999999999999b";
    const wrongAddressLog = buildDeliveryTimeoutClaimedLog({ address: otherAddress });

    const decoded = findDeliveryTimeoutClaimedLog([wrongAddressLog], TASK_ESCROW_ADDRESS);
    expect(decoded).toBeNull();
  });

  it("returns null when no log matches", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS });
    expect(findDeliveryTimeoutClaimedLog([transferLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });
});
