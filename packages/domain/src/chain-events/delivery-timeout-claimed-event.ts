import { decodeEventLog } from "viem";
import type { RawEventLog } from "./task-funded-event.js";

/**
 * Hand-written ABI fragment for `TaskEscrow.DeliveryTimeoutClaimed` — same
 * rationale as `task-funded-event.ts`'s `TASK_FUNDED_EVENT_ABI`. Copied
 * verbatim from `contracts/src/TaskEscrow.sol`'s
 * `event DeliveryTimeoutClaimed(bytes32 indexed taskId, address indexed
 * requester, uint256 budget, uint256 stake)` and only changes if that
 * Solidity signature changes.
 */
export const DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI = [
  {
    type: "event",
    name: "DeliveryTimeoutClaimed",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "budget", type: "uint256", indexed: false },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface DecodedDeliveryTimeoutClaimedEvent {
  taskId: `0x${string}`;
  requester: `0x${string}`;
  budget: bigint;
  stake: bigint;
}

/**
 * Decodes a single log as `DeliveryTimeoutClaimed` using the ABI fragment
 * above. Returns `null` (never throws) when the log doesn't match the
 * event signature or fails to decode.
 */
export function decodeDeliveryTimeoutClaimedLog(
  log: RawEventLog,
): DecodedDeliveryTimeoutClaimedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "DeliveryTimeoutClaimed") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `DeliveryTimeoutClaimed`.
 */
export function findDeliveryTimeoutClaimedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedDeliveryTimeoutClaimedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeDeliveryTimeoutClaimedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
