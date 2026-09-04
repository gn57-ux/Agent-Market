import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.DisputeOpened` — same
 * rationale as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI`. Copied
 * verbatim from `contracts/src/TaskEscrow.sol`'s
 * `event DisputeOpened(bytes32 indexed taskId, address indexed requester,
 * bytes32 disputeEvidenceHash)` and only changes if that Solidity
 * signature changes.
 */
export const DISPUTE_OPENED_EVENT_ABI = [
  {
    type: "event",
    name: "DisputeOpened",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "disputeEvidenceHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

export interface DecodedDisputeOpenedEvent {
  taskId: `0x${string}`;
  requester: `0x${string}`;
  disputeEvidenceHash: `0x${string}`;
}

/**
 * Decodes a single log as `DisputeOpened` using the ABI fragment above.
 * Returns `null` (never throws) when the log doesn't match the event
 * signature or fails to decode.
 */
export function decodeDisputeOpenedLog(log: RawEventLog): DecodedDisputeOpenedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: DISPUTE_OPENED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "DisputeOpened") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `DisputeOpened`.
 */
export function findDisputeOpenedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedDisputeOpenedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeDisputeOpenedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
