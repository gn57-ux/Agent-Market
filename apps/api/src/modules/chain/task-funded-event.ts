import { decodeEventLog } from "viem";

/**
 * Hand-written ABI fragment for `TaskEscrow.TaskFunded` — deliberately NOT
 * imported from `contracts/artifacts/` (Hardhat's compiled output). That
 * directory is gitignored build output that only exists after
 * `pnpm --filter @agent-market/contracts compile` has been run; coupling
 * `apps/api` to it would make "run the API without ever having touched the
 * Hardhat project" fail with a confusing missing-file error instead of just
 * working. The event shape below is copied from
 * `contracts/src/TaskEscrow.sol`'s `event TaskFunded(bytes32 indexed
 * taskId, address indexed requester, address token, uint256 budget, uint64
 * deliveryDeadline)` and only changes if that Solidity signature changes.
 */
export const TASK_FUNDED_EVENT_ABI = [
  {
    type: "event",
    name: "TaskFunded",
    inputs: [
      { name: "taskId", type: "bytes32", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "budget", type: "uint256", indexed: false },
      { name: "deliveryDeadline", type: "uint64", indexed: false },
    ],
  },
] as const;

/** Minimal shape of a receipt log this module needs to decode — matches
 * both viem's real log type and the fakes `rpc.client.ts`'s test doubles
 * construct, without pulling viem's full `Log` type into every caller. */
export interface RawEventLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: number;
}

export interface DecodedTaskFundedEvent {
  taskId: `0x${string}`;
  requester: `0x${string}`;
  token: `0x${string}`;
  budget: bigint;
  deliveryDeadline: bigint;
}

/**
 * Decodes a single log as `TaskFunded` using the ABI fragment above.
 * Returns `null` (never throws) when the log doesn't match the event
 * signature or fails to decode — "not a TaskFunded log" is an expected,
 * routine outcome for the majority of logs a receipt can contain (e.g. the
 * ERC-20 `Transfer` log `safeTransferFrom` also emits), not an exceptional
 * one.
 *
 * Shared by `tx-verifier.ts` (the `funding-verifications` request path)
 * and `event-sync.ts` (background event-sync fallback) so both
 * consume exactly one decode implementation — CLAUDE.md 原则 6: 设计知识只能有
 * 一个归属.
 */
export function decodeTaskFundedLog(log: RawEventLog): DecodedTaskFundedEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: TASK_FUNDED_EVENT_ABI,
      data: log.data as `0x${string}`,
      topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    });
    if (decoded.eventName !== "TaskFunded") {
      return null;
    }
    return decoded.args;
  } catch {
    return null;
  }
}

/**
 * Scans a receipt's logs for the first log emitted by `trustedAddress` that
 * decodes as `TaskFunded`. Callers are expected to have already confirmed
 * the transaction's `to` is `trustedAddress` (tx-verifier.ts step order),
 * but this function re-checks the log's own `address` independently rather
 * than trusting that — a receipt can contain logs from other contracts
 * (e.g. the ERC-20 token's `Transfer` log) even when `to` matches.
 */
export function findTaskFundedLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedTaskFundedEvent | null {
  const normalizedTrusted = trustedAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeTaskFundedLog(log);
    if (decoded) {
      return decoded;
    }
  }
  return null;
}
