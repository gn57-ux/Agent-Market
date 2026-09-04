import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import {
  TASK_FUNDED_EVENT_ABI,
  TASK_CANCELLED_EVENT_ABI,
  type RawEventLog,
} from "@agent-market/domain";
import { decodeAnyEvent } from "./decode-any-event.js";

/**
 * Every individual `decode*Log` function's own correctness (real
 * ABI-encoded fixtures, malformed-data edge cases, etc.) is already
 * covered by packages/domain/src/chain-events/*.test.ts (106 tests) — this
 * file's own job is narrower: prove `decodeAnyEvent`'s DISPATCH logic
 * (which of the 9 decoders actually matches a given log, first-match-wins)
 * works, not re-prove each decoder's own internals.
 */
const TASK_ESCROW_ADDRESS = "0x111111111111111111111111111111111111111a";
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TASK_ID = keccak256(toHex("task-1"));

function buildTaskFundedLog(): RawEventLog {
  const topics = encodeEventTopics({
    abi: TASK_FUNDED_EVENT_ABI,
    eventName: "TaskFunded",
    args: { taskId: TASK_ID, requester: getAddress(REQUESTER_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "deliveryDeadline", type: "uint64" },
    ],
    [getAddress(TOKEN_ADDRESS), 1_000n, 1_893_456_000n],
  );
  return { address: TASK_ESCROW_ADDRESS, topics, data, logIndex: 0 };
}

function buildTaskCancelledLog(): RawEventLog {
  const topics = encodeEventTopics({
    abi: TASK_CANCELLED_EVENT_ABI,
    eventName: "TaskCancelled",
    args: { taskId: TASK_ID },
  }) as readonly string[];
  return { address: TASK_ESCROW_ADDRESS, topics, data: "0x", logIndex: 1 };
}

function buildErc20TransferLog(): RawEventLog {
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
  return { address: TOKEN_ADDRESS, topics, data, logIndex: 2 };
}

describe("decodeAnyEvent", () => {
  it("dispatches a real TaskFunded log to its own decoder", () => {
    const result = decodeAnyEvent(buildTaskFundedLog());
    expect(result?.eventType).toBe("TaskFunded");
    expect((result?.payload as { budget: bigint }).budget).toBe(1_000n);
  });

  it("dispatches a real TaskCancelled log to its own decoder — the 9th event type, added by Feature 17 after this Feature's own spec was written, still indexed (F-1807: 全部事件类型)", () => {
    const result = decodeAnyEvent(buildTaskCancelledLog());
    expect(result?.eventType).toBe("TaskCancelled");
    expect((result?.payload as { taskId: string }).taskId.toLowerCase()).toBe(
      TASK_ID.toLowerCase(),
    );
  });

  it("returns null for a log that matches none of the 9 known event types", () => {
    expect(decodeAnyEvent(buildErc20TransferLog())).toBeNull();
  });

  it("returns null for a log with a garbage signature topic", () => {
    const log: RawEventLog = {
      address: TASK_ESCROW_ADDRESS,
      topics: [pad(toHex(0), { size: 32 })],
      data: "0x",
      logIndex: 0,
    };
    expect(decodeAnyEvent(log)).toBeNull();
  });
});
