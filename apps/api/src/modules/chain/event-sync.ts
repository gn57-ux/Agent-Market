import type { ChainRpcClient } from "./rpc.client.js";
import {
  decodeDeliveryTimeoutClaimedLog,
  type DecodedDeliveryTimeoutClaimedEvent,
} from "./delivery-timeout-claimed-event.js";
import { decodeDisputeOpenedLog, type DecodedDisputeOpenedEvent } from "./dispute-opened-event.js";
import {
  decodeDisputeResolvedLog,
  type DecodedDisputeResolvedEvent,
} from "./dispute-resolved-event.js";
import {
  decodeResultApprovedLog,
  type DecodedResultApprovedEvent,
} from "./result-approved-event.js";
import {
  decodeResultSubmittedLog,
  type DecodedResultSubmittedEvent,
} from "./result-submitted-event.js";
import {
  decodeReviewTimeoutFinalizedLog,
  type DecodedReviewTimeoutFinalizedEvent,
} from "./review-timeout-finalized-event.js";
import { decodeTaskAcceptedLog, type DecodedTaskAcceptedEvent } from "./task-accepted-event.js";
import { decodeTaskCancelledLog, type DecodedTaskCancelledEvent } from "./task-cancelled-event.js";
import {
  decodeTaskFundedLog,
  type DecodedTaskFundedEvent,
  type RawEventLog,
} from "./task-funded-event.js";

/**
 * F-606's fallback path ("复核逻辑幂等" / requirements.md's non-functional
 * requirement: "链重组时未达最终确认数的投影可回滚重新同步"): this module is
 * the background counterpart to `tx-verifier.ts`'s synchronous
 * `funding-verifications` request path (design.md's 技术决策 table —
 * "两者共享同一套 tx-verifier 规则"). It does not re-implement log
 * decoding: `decodeTaskFundedLog` is imported from `task-funded-event.ts`,
 * the single place both this module and `tx-verifier.ts` get that logic
 * from.
 *
 * This file intentionally ships only the two pieces of logic that are
 * genuinely reusable and independently testable without a live chain:
 * decoding a `TaskFunded` event out of a receipt log, and deciding whether
 * an existing `chain_events` projection row needs to be rolled back because
 * its block is no longer canonical. Wiring this into a poller/cron that
 * walks `chain_events` rows and calls a real `ChainRpcClient` is future
 * work for whichever Feature actually needs the background sync running
 * continuously — out of this task's scope (T-603 capsule: rpc.client +
 * tx-verifier, F-605).
 */

export interface FundedEventLogDecodeResult {
  event: DecodedTaskFundedEvent;
  logIndex: number;
}

/**
 * Decodes every `TaskFunded` log emitted by `trustedContractAddress` in a
 * set of receipt logs (a receipt can only reasonably contain one `TaskFunded`
 * log per `createTask` call, but this doesn't assume that — it decodes all
 * matches so a caller can detect an unexpected duplicate rather than
 * silently keeping only the first).
 */
export function decodeFundedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): FundedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: FundedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeTaskFundedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface AcceptedEventLogDecodeResult {
  event: DecodedTaskAcceptedEvent;
  logIndex: number;
}

/**
 * Decodes every `TaskAccepted` log emitted by `trustedContractAddress` in a
 * set of receipt logs — T-801's mirror of `decodeFundedEventsFromLogs`
 * above, same reasoning: a receipt can only reasonably contain one
 * `TaskAccepted` log per `acceptTask` call, but this doesn't assume that,
 * decoding all matches so a caller can detect an unexpected duplicate
 * rather than silently keeping only the first.
 */
export function decodeAcceptedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): AcceptedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: AcceptedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeTaskAcceptedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface ResultSubmittedEventLogDecodeResult {
  event: DecodedResultSubmittedEvent;
  logIndex: number;
}

/**
 * Decodes every `ResultSubmitted` log emitted by `trustedContractAddress`
 * in a set of receipt logs — T-905's mirror of
 * `decodeAcceptedEventsFromLogs` above, same reasoning: a receipt can only
 * reasonably contain one `ResultSubmitted` log per `submitResult` call,
 * but this doesn't assume that, decoding all matches so a caller can
 * detect an unexpected duplicate rather than silently keeping only the
 * first.
 */
export function decodeResultSubmittedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): ResultSubmittedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: ResultSubmittedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeResultSubmittedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface ResultApprovedEventLogDecodeResult {
  event: DecodedResultApprovedEvent;
  logIndex: number;
}

/**
 * Decodes every `ResultApproved` log emitted by `trustedContractAddress`
 * in a set of receipt logs — T-1001's mirror of
 * `decodeResultSubmittedEventsFromLogs` above.
 */
export function decodeResultApprovedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): ResultApprovedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: ResultApprovedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeResultApprovedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface DeliveryTimeoutClaimedEventLogDecodeResult {
  event: DecodedDeliveryTimeoutClaimedEvent;
  logIndex: number;
}

/**
 * Decodes every `DeliveryTimeoutClaimed` log emitted by
 * `trustedContractAddress` in a set of receipt logs — T-1001's mirror of
 * `decodeResultSubmittedEventsFromLogs` above.
 */
export function decodeDeliveryTimeoutClaimedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): DeliveryTimeoutClaimedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: DeliveryTimeoutClaimedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeDeliveryTimeoutClaimedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface ReviewTimeoutFinalizedEventLogDecodeResult {
  event: DecodedReviewTimeoutFinalizedEvent;
  logIndex: number;
}

/**
 * Decodes every `ReviewTimeoutFinalized` log emitted by
 * `trustedContractAddress` in a set of receipt logs — T-1001's mirror of
 * `decodeResultSubmittedEventsFromLogs` above.
 */
export function decodeReviewTimeoutFinalizedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): ReviewTimeoutFinalizedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: ReviewTimeoutFinalizedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeReviewTimeoutFinalizedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface DisputeOpenedEventLogDecodeResult {
  event: DecodedDisputeOpenedEvent;
  logIndex: number;
}

/**
 * Decodes every `DisputeOpened` log emitted by `trustedContractAddress` in
 * a set of receipt logs — T-1002's mirror of
 * `decodeResultSubmittedEventsFromLogs` above.
 */
export function decodeDisputeOpenedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): DisputeOpenedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: DisputeOpenedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeDisputeOpenedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface DisputeResolvedEventLogDecodeResult {
  event: DecodedDisputeResolvedEvent;
  logIndex: number;
}

/**
 * Decodes every `DisputeResolved` log emitted by `trustedContractAddress`
 * in a set of receipt logs — T-1002's mirror of
 * `decodeResultSubmittedEventsFromLogs` above.
 */
export function decodeDisputeResolvedEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): DisputeResolvedEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: DisputeResolvedEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeDisputeResolvedLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

export interface TaskCancelledEventLogDecodeResult {
  event: DecodedTaskCancelledEvent;
  logIndex: number;
}

/**
 * Decodes every `TaskCancelled` log emitted by `trustedContractAddress` in
 * a set of receipt logs — T-1705's mirror of
 * `decodeResultSubmittedEventsFromLogs` above.
 */
export function decodeTaskCancelledEventsFromLogs(
  logs: readonly RawEventLog[],
  trustedContractAddress: string,
): TaskCancelledEventLogDecodeResult[] {
  const normalizedTrusted = trustedContractAddress.toLowerCase();
  const results: TaskCancelledEventLogDecodeResult[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedTrusted) {
      continue;
    }
    const decoded = decodeTaskCancelledLog(log);
    if (decoded) {
      results.push({ event: decoded, logIndex: log.logIndex });
    }
  }
  return results;
}

/** The minimal shape of an unconfirmed `chain_events` projection row this
 * module's reorg check needs — deliberately not the full DB row type
 * (payload, processed_at, etc.), matching `rpc.client.ts`'s "narrow
 * interface, not the whole DB/viem type" pattern. */
export interface UnconfirmedEventProjection {
  blockNumber: bigint;
  blockHash: string;
}

/**
 * Reorg rollback judgment (requirements.md: "链重组时未达最终确认数的投影可
 * 回滚重新同步"): given a `chain_events` row that was projected from a block
 * that has not yet reached final confirmations, and the block the RPC
 * currently reports as canonical at that same height, decides whether the
 * row must be deleted and its event re-synced from scratch.
 *
 * Only rows that have NOT reached final confirmation are ever candidates
 * for this check — a caller must not invoke this for a row already past
 * `requiredConfirmations` (per requirements.md's "未达到最终确认数的...投影"
 * qualifier); this function itself does not track confirmation counts, that
 * bookkeeping belongs to whatever poller calls it.
 *
 * `canonicalBlock: null` means the RPC no longer resolves any block at that
 * height at all (e.g. the chain shrank, or the node is behind) — treated
 * the same as a hash mismatch: the projection can no longer be trusted, so
 * it must be rolled back.
 *
 * NOTE ON TEST COVERAGE: this is pure decision logic over already-fetched
 * block identifiers. It is unit-tested directly (old blockHash vs a
 * different new blockHash) without any real RPC or Hardhat node involved.
 * That is NOT the same as an end-to-end proof that this project correctly
 * detects and recovers from a real chain reorg on a running Hardhat/testnet
 * node — no such environment is available in this task's context (no local
 * Hardhat node running, and simulating a real reorg would require one). The
 * unit test here only proves the rollback *decision* is correct given
 * whatever blocks the RPC layer reports; it does not exercise the RPC layer
 * itself under a real reorg.
 */
export function shouldRollbackForReorg(
  projection: UnconfirmedEventProjection,
  canonicalBlock: { hash: string; number: bigint } | null,
): boolean {
  if (!canonicalBlock) {
    return true;
  }
  if (canonicalBlock.number !== projection.blockNumber) {
    // Caller error guard: comparing against a block at a different height
    // isn't a reorg signal, it's a mismatched query. Treat conservatively
    // as "cannot confirm this projection is still canonical" — but this
    // should never happen if callers query `getBlock` at `projection.blockNumber`.
    return true;
  }
  return canonicalBlock.hash.toLowerCase() !== projection.blockHash.toLowerCase();
}

/**
 * Convenience wrapper around `shouldRollbackForReorg` for a caller that has
 * a live `ChainRpcClient` rather than an already-fetched block — fetches
 * the current canonical block at the projection's height and applies the
 * same judgment. Kept separate from the pure function above so the pure
 * decision logic stays trivially unit-testable without any RPC client at
 * all (see the NOTE above).
 */
export async function checkProjectionForReorg(
  rpc: ChainRpcClient,
  projection: UnconfirmedEventProjection,
): Promise<boolean> {
  const canonicalBlock = await rpc.getBlock({ blockNumber: projection.blockNumber });
  return shouldRollbackForReorg(projection, canonicalBlock);
}
