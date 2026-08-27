import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeResultSubmittedLog,
  findResultSubmittedLog,
  RESULT_SUBMITTED_EVENT_ABI,
} from "./result-submitted-event.js";
import type { RawEventLog } from "./task-funded-event.js";

const TASK_ESCROW_ADDRESS = "0x111111111111111111111111111111111111111a";
const AGENT_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID_ON_CHAIN = keccak256(toHex("task-1"));
const RESULT_HASH = keccak256(toHex("result content"));
const SUBMITTED_AT = 1_800_000_000n;
const REVIEW_DEADLINE = SUBMITTED_AT + 259_200n;

/**
 * Builds a real, ABI-encoded `ResultSubmitted` log the same way viem's
 * `decodeEventLog` (used by `decodeResultSubmittedLog`) expects to consume
 * one — mirrors `task-accepted-event.test.ts`'s `buildTaskAcceptedLog`: not
 * a hand-typed string fixture, so a bug in the hand-written ABI fragment in
 * result-submitted-event.ts could not slip past these tests unnoticed.
 */
function buildResultSubmittedLog(overrides: {
  address?: string;
  taskId?: `0x${string}`;
  agent?: `0x${string}`;
  resultHash?: `0x${string}`;
  submittedAt?: bigint;
  reviewDeadline?: bigint;
  logIndex?: number;
}): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const agent = overrides.agent ?? AGENT_ADDRESS;
  const resultHash = overrides.resultHash ?? RESULT_HASH;
  const submittedAt = overrides.submittedAt ?? SUBMITTED_AT;
  const reviewDeadline = overrides.reviewDeadline ?? REVIEW_DEADLINE;

  const topics = encodeEventTopics({
    abi: RESULT_SUBMITTED_EVENT_ABI,
    eventName: "ResultSubmitted",
    args: { taskId, agent: getAddress(agent) },
  }) as readonly string[];

  const data = encodeAbiParameters(
    [
      { name: "resultHash", type: "bytes32" },
      { name: "submittedAt", type: "uint64" },
      { name: "reviewDeadline", type: "uint64" },
    ],
    [resultHash, submittedAt, reviewDeadline],
  );

  return {
    address: overrides.address ?? TASK_ESCROW_ADDRESS,
    topics,
    data,
    logIndex: overrides.logIndex ?? 0,
  };
}

/** A real, ABI-encoded ERC-20 `Transfer(address,address,uint256)` log —
 * used to prove `findResultSubmittedLog` actually skips non-matching logs
 * rather than happening to only ever be tested with ResultSubmitted logs. */
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

describe("decodeResultSubmittedLog", () => {
  it("decodes a real, ABI-encoded ResultSubmitted log", () => {
    const log = buildResultSubmittedLog({});
    const decoded = decodeResultSubmittedLog(log);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(decoded?.agent.toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    expect(decoded?.resultHash.toLowerCase()).toBe(RESULT_HASH.toLowerCase());
    expect(decoded?.submittedAt).toBe(SUBMITTED_AT);
    expect(decoded?.reviewDeadline).toBe(REVIEW_DEADLINE);
  });

  it("returns null (not a throw) for a log whose topics don't match the ResultSubmitted signature", () => {
    const log = buildErc20TransferLog();
    expect(decodeResultSubmittedLog(log)).toBeNull();
  });

  it("returns null for a log with an unrecognizable/garbage signature topic", () => {
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics: [pad(toHex(0), { size: 32 })],
      data: "0x",
      logIndex: 0,
    };
    expect(decodeResultSubmittedLog(log)).toBeNull();
  });

  it("returns null when data can't be decoded against the expected non-indexed params", () => {
    const topics = encodeEventTopics({
      abi: RESULT_SUBMITTED_EVENT_ABI,
      eventName: "ResultSubmitted",
      args: { taskId: TASK_ID_ON_CHAIN, agent: getAddress(AGENT_ADDRESS) },
    }) as readonly string[];
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics,
      data: "0x1234", // too short / malformed for (bytes32, uint64, uint64)
      logIndex: 0,
    };
    expect(decodeResultSubmittedLog(log)).toBeNull();
  });
});

describe("findResultSubmittedLog", () => {
  it("finds the ResultSubmitted log emitted by trustedAddress, skipping a Transfer log from another contract", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS, logIndex: 0 });
    const submittedLog = buildResultSubmittedLog({ address: TASK_ESCROW_ADDRESS, logIndex: 1 });

    const decoded = findResultSubmittedLog([transferLog, submittedLog], TASK_ESCROW_ADDRESS);

    expect(decoded).not.toBeNull();
    expect(decoded?.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
  });

  it("is case-insensitive when matching the trusted address", () => {
    const submittedLog = buildResultSubmittedLog({
      address: TASK_ESCROW_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    const decoded = findResultSubmittedLog([submittedLog], TASK_ESCROW_ADDRESS.toLowerCase());
    expect(decoded).not.toBeNull();
  });

  it("skips a ResultSubmitted-shaped log emitted from an untrusted address", () => {
    const otherAddress = "0x999999999999999999999999999999999999999b";
    const submittedLogFromWrongAddress = buildResultSubmittedLog({ address: otherAddress });

    const decoded = findResultSubmittedLog([submittedLogFromWrongAddress], TASK_ESCROW_ADDRESS);
    expect(decoded).toBeNull();
  });

  it("returns null when no log matches", () => {
    const transferLog = buildErc20TransferLog({ address: TOKEN_ADDRESS });
    expect(findResultSubmittedLog([transferLog], TASK_ESCROW_ADDRESS)).toBeNull();
  });
});
