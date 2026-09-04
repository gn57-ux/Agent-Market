import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.ReviewTimeoutFinalized` — same
 * rationale as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI`. Copied
 * verbatim from `contracts/src/TaskEscrow.sol`'s
 * `event ReviewTimeoutFinalized(bytes32 indexed taskId, address indexed
 * agent, uint256 budget, uint256 stake)` and only changes if that Solidity
 * signature changes.
 */
export const REVIEW_TIMEOUT_FINALIZED_EVENT_ABI = [
  {
    type: "event",
    name: "ReviewTimeoutFinalized",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "budget", type: "uint256", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface DecodedReviewTimeoutFinalizedEvent {
  taskId: `0x${string}`;
  agent: `0x${string}`;
  budget: bigint;
  stake: bigint;
}

/**
 * Decodes a single log as `ReviewTimeoutFinalized` using the ABI fragment
 * above. Returns `null` (never throws) when the log doesn't match the
 * event signature or fails to decode.
 */
export function decodeReviewTimeoutFinalizedLog(
  log: RawEventLog,
): DecodedReviewTimeoutFinalizedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: REVIEW_TIMEOUT_FINALIZED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "ReviewTimeoutFinalized") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `ReviewTimeoutFinalized`.
 */
export function findReviewTimeoutFinalizedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedReviewTimeoutFinalizedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeReviewTimeoutFinalizedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
