import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.TaskCancelled` — same
 * rationale as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI`. Copied
 * verbatim from `contracts/src/TaskEscrow.sol`'s
 * `event TaskCancelled(bytes32 indexed taskId)` and only changes if that
 * Solidity signature changes.
 */
export const TASK_CANCELLED_EVENT_ABI = [
  {
    type: "event",
    name: "TaskCancelled",
    inputs: [{ name: "taskId", type: "bytes32", indexed: true }],
  },
] as const;

export interface DecodedTaskCancelledEvent {
  taskId: `0x${string}`;
}

/**
 * Decodes a single log as `TaskCancelled` using the ABI fragment above.
 * Returns `null` (never throws) when the log doesn't match the event
 * signature or fails to decode.
 */
export function decodeTaskCancelledLog(log: RawEventLog): DecodedTaskCancelledEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: TASK_CANCELLED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "TaskCancelled") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `TaskCancelled`.
 */
export function findTaskCancelledLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedTaskCancelledEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeTaskCancelledLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
