import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.ResultSubmitted` — same
 * rationale as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI` (not
 * imported from `contracts/artifacts/`, gitignored Hardhat build output).
 * Copied verbatim from `contracts/src/TaskEscrow.sol`'s
 * `event ResultSubmitted(bytes32 indexed taskId, address indexed agent,
 * bytes32 resultHash, uint64 submittedAt, uint64 reviewDeadline)` and only
 * changes if that Solidity signature changes.
 */
export const RESULT_SUBMITTED_EVENT_ABI = [
  {
    type: "event",
    name: "ResultSubmitted",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "resultHash", type: "bytes32", indexed: false },
      { name: "submittedAt", type: "uint64", indexed: false },
      { name: "reviewDeadline", type: "uint64", indexed: false },
    ],
  },
] as const;

export interface DecodedResultSubmittedEvent {
  taskId: `0x${string}`;
  agent: `0x${string}`;
  resultHash: `0x${string}`;
  submittedAt: bigint;
  reviewDeadline: bigint;
}

/**
 * Decodes a single log as `ResultSubmitted` using the ABI fragment above.
 * Returns `null` (never throws) when the log doesn't match the event
 * signature or fails to decode — mirrors `decodeTaskAcceptedLog`'s exact
 * contract, for the same reason: "not a ResultSubmitted log" is a routine
 * outcome for most logs a receipt can contain, not an exceptional one.
 */
export function decodeResultSubmittedLog(log: RawEventLog): DecodedResultSubmittedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: RESULT_SUBMITTED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "ResultSubmitted") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `ResultSubmitted`. Mirrors `findTaskAcceptedLog`'s exact
 * contract — re-checks the log's own `address` independently rather than
 * trusting a caller's prior `receipt.to` check, since a receipt can
 * contain logs from other contracts.
 */
export function findResultSubmittedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedResultSubmittedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeResultSubmittedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
