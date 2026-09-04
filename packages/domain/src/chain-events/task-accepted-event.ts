import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.TaskAccepted` — same rationale
 * as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI` (deliberately NOT
 * imported from `contracts/artifacts/`, gitignored Hardhat build output).
 * Copied verbatim from `contracts/src/TaskEscrow.sol:115`'s
 * `event TaskAccepted(bytes32 indexed taskId, address indexed agent,
 * uint256 stake)` and only changes if that Solidity signature changes.
 */
export const TASK_ACCEPTED_EVENT_ABI = [
  {
    type: "event",
    name: "TaskAccepted",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface DecodedTaskAcceptedEvent {
  taskId: `0x${string}`;
  agent: `0x${string}`;
  stake: bigint;
}

/**
 * Decodes a single log as `TaskAccepted` using the ABI fragment above.
 * Returns `null` (never throws) when the log doesn't match the event
 * signature or fails to decode — mirrors `decodeTaskFundedLog`'s exact
 * contract, for the same reason: "not a TaskAccepted log" is a routine
 * outcome for most logs a receipt can contain, not an exceptional one.
 */
export function decodeTaskAcceptedLog(log: RawEventLog): DecodedTaskAcceptedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: TASK_ACCEPTED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "TaskAccepted") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `TaskAccepted`. Mirrors `findTaskFundedLog`'s exact contract —
 * re-checks the log's own `address` independently rather than trusting a
 * caller's prior `receipt.to` check, since a receipt can contain logs from
 * other contracts.
 */
export function findTaskAcceptedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedTaskAcceptedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeTaskAcceptedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
