import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.DisputeResolved` — same
 * rationale as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI`. Copied
 * verbatim from `contracts/src/TaskEscrow.sol`'s
 * `event DisputeResolved(bytes32 indexed taskId, bool supportAgent)` and
 * only changes if that Solidity signature changes.
 */
export const DISPUTE_RESOLVED_EVENT_ABI = [
  {
    type: "event",
    name: "DisputeResolved",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "supportAgent", type: "bool", indexed: false },
    ],
  },
] as const;

export interface DecodedDisputeResolvedEvent {
  taskId: `0x${string}`;
  supportAgent: boolean;
}

/**
 * Decodes a single log as `DisputeResolved` using the ABI fragment above.
 * Returns `null` (never throws) when the log doesn't match the event
 * signature or fails to decode.
 */
export function decodeDisputeResolvedLog(log: RawEventLog): DecodedDisputeResolvedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: DISPUTE_RESOLVED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "DisputeResolved") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `DisputeResolved`.
 */
export function findDisputeResolvedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedDisputeResolvedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeDisputeResolvedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
