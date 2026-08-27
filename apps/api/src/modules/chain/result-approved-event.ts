import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.ResultApproved` — same
 * rationale as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI` (not
 * imported from `contracts/artifacts/`, gitignored Hardhat build output).
 * Copied verbatim from `contracts/src/TaskEscrow.sol`'s
 * `event ResultApproved(bytes32 indexed taskId, address indexed agent,
 * uint256 budget, uint256 stake)` and only changes if that Solidity
 * signature changes.
 */
export const RESULT_APPROVED_EVENT_ABI = [
  {
    type: "event",
    name: "ResultApproved",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "budget", type: "uint256", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface DecodedResultApprovedEvent {
  taskId: `0x${string}`;
  agent: `0x${string}`;
  budget: bigint;
  stake: bigint;
}

/**
 * Decodes a single log as `ResultApproved` using the ABI fragment above.
 * Returns `null` (never throws) when the log doesn't match the event
 * signature or fails to decode — mirrors `decodeResultSubmittedLog`'s
 * exact contract.
 */
export function decodeResultApprovedLog(log: RawEventLog): DecodedResultApprovedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: RESULT_APPROVED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "ResultApproved") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `ResultApproved`. Mirrors `findResultSubmittedLog`'s exact
 * contract — re-checks the log's own `address` independently rather than
 * trusting a caller's prior `receipt.to` check.
 */
export function findResultApprovedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedResultApprovedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeResultApprovedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
