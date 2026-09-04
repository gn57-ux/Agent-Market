import type { ErrorCode } from "@agent-market/domain";
import type { ChainRpcClient } from "./rpc.client.js";
import type { RawEventLog } from "@agent-market/domain";
import { findResultApprovedLog, type DecodedResultApprovedEvent } from "@agent-market/domain";
import {
  findDeliveryTimeoutClaimedLog,
  type DecodedDeliveryTimeoutClaimedEvent,
} from "@agent-market/domain";
import {
  findReviewTimeoutFinalizedLog,
  type DecodedReviewTimeoutFinalizedEvent,
} from "@agent-market/domain";

// Same bind-every-code-to-a-const discipline as tx-verifier.ts/
// acceptance-tx-verifier.ts/result-submission-tx-verifier.ts.
const CHAIN_UNSUPPORTED: ErrorCode = "CHAIN_UNSUPPORTED";
const TRANSACTION_NOT_FOUND: ErrorCode = "TRANSACTION_NOT_FOUND";
const TRANSACTION_NOT_CONFIRMED: ErrorCode = "TRANSACTION_NOT_CONFIRMED";
const EVENT_MISMATCH: ErrorCode = "FUNDING_EVENT_MISMATCH";
const RPC_TEMPORARILY_UNAVAILABLE: ErrorCode = "RPC_TEMPORARILY_UNAVAILABLE";

/**
 * A settlement transaction can be exactly ONE of three different
 * contract functions (`approveResult`/`claimDeliveryTimeout`/
 * `finalizeReviewTimeout`), unlike every earlier verifier in this
 * codebase (which each expect exactly one fixed event) — this is the
 * discriminated result of trying all three decoders against the same
 * receipt. Unlike `result-submission-tx-verifier.ts`, this module never
 * cross-checks "the caller equals some expected address": the contract
 * itself already enforces every access rule that matters for these three
 * functions (`task.requester` for the first two, unrestricted for the
 * third — TaskEscrow.sol's own NatSpec), so there is nothing for this
 * backend to re-derive or validate beyond "does a real, confirmed log of
 * one of these three shapes exist for this task".
 */
export type DecodedSettlementEvent =
  | { kind: "RESULT_APPROVED"; event: DecodedResultApprovedEvent }
  | { kind: "DELIVERY_TIMEOUT_CLAIMED"; event: DecodedDeliveryTimeoutClaimedEvent }
  | { kind: "REVIEW_TIMEOUT_FINALIZED"; event: DecodedReviewTimeoutFinalizedEvent };

function findSettlementLog(
  logs: readonly RawEventLog[],
  trustedAddress: string,
): DecodedSettlementEvent | null {
  const approved = findResultApprovedLog(logs, trustedAddress);
  if (approved) return { kind: "RESULT_APPROVED", event: approved };
  const claimed = findDeliveryTimeoutClaimedLog(logs, trustedAddress);
  if (claimed) return { kind: "DELIVERY_TIMEOUT_CLAIMED", event: claimed };
  const finalized = findReviewTimeoutFinalizedLog(logs, trustedAddress);
  if (finalized) return { kind: "REVIEW_TIMEOUT_FINALIZED", event: finalized };
  return null;
}

export interface VerifySettlementTransactionParams {
  rpc: ChainRpcClient;
  txHash: `0x${string}`;
  expectedChainId: number;
  trustedContractAddress: `0x${string}`;
  requiredConfirmations: number;
  /** bytes32 on-chain task id (`onchain-task-id.ts`'s `deriveOnChainTaskId`
   * applied to `tasks.id`) — the ONE thing this verifier does cross-check
   * against the request, since a caller could otherwise submit a
   * completely unrelated (but real, confirmed) settlement tx hash for a
   * different task entirely. */
  expectedTaskIdOnChain: `0x${string}`;
}

export type SettlementVerificationResult =
  | {
      ok: true;
      decoded: DecodedSettlementEvent;
      confirmations: number;
      blockHash: `0x${string}`;
    }
  | { ok: false; code: ErrorCode; message: string };

function mismatch(message: string): SettlementVerificationResult {
  return { ok: false, code: EVENT_MISMATCH, message };
}

function notConfirmed(message: string): SettlementVerificationResult {
  return { ok: false, code: TRANSACTION_NOT_CONFIRMED, message };
}

/**
 * RPC-only, database-free verification of a settlement transaction —
 * same check order/error-code discipline as
 * `result-submission-tx-verifier.ts`'s `verifyResultSubmissionTransaction`:
 *
 *   1. receipt exists                        → else TRANSACTION_NOT_FOUND
 *   2. chainId matches the configured chain   → else CHAIN_UNSUPPORTED
 *   3. receipt status is success              → else TRANSACTION_NOT_CONFIRMED
 *   4. confirmations reached AND the block at
 *      that height is still canonical         → else TRANSACTION_NOT_CONFIRMED
 *   5. receipt `to` is the trusted contract   → else FUNDING_EVENT_MISMATCH (reused)
 *   6. one of the three settlement event
 *      shapes decodes                         → else FUNDING_EVENT_MISMATCH (reused)
 *   7. decoded taskId matches expected        → else FUNDING_EVENT_MISMATCH (reused)
 *
 * Any unexpected RPC error is caught and turned into
 * `RPC_TEMPORARILY_UNAVAILABLE`, never a thrown exception.
 */
export async function verifySettlementTransaction(
  params: VerifySettlementTransactionParams,
): Promise<SettlementVerificationResult> {
  const { rpc, txHash, expectedChainId, trustedContractAddress, requiredConfirmations } = params;

  try {
    const receipt = await rpc.getTransactionReceipt(txHash);
    if (!receipt) {
      return { ok: false, code: TRANSACTION_NOT_FOUND, message: `no receipt found for ${txHash}` };
    }

    const chainId = await rpc.getChainId();
    if (chainId !== expectedChainId) {
      return {
        ok: false,
        code: CHAIN_UNSUPPORTED,
        message: `RPC reports chainId ${chainId}, expected ${expectedChainId}`,
      };
    }

    if (receipt.status !== "success") {
      return notConfirmed(`transaction status is "${receipt.status}", not "success"`);
    }

    const currentBlockNumber = await rpc.getBlockNumber();
    const confirmations = currentBlockNumber - receipt.blockNumber + 1n;
    if (confirmations < BigInt(requiredConfirmations)) {
      return notConfirmed(
        `only ${confirmations} confirmation(s), required ${requiredConfirmations}`,
      );
    }

    const canonicalBlock = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    if (!canonicalBlock || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      return notConfirmed(
        `block ${receipt.blockNumber} at hash ${receipt.blockHash} is no longer canonical (reorg)`,
      );
    }

    if (!receipt.to || receipt.to.toLowerCase() !== trustedContractAddress.toLowerCase()) {
      return mismatch(
        `transaction "to" is ${receipt.to ?? "null"}, expected trusted contract ${trustedContractAddress}`,
      );
    }

    const decoded = findSettlementLog(receipt.logs, trustedContractAddress);
    if (!decoded) {
      return mismatch(
        "no ResultApproved/DeliveryTimeoutClaimed/ReviewTimeoutFinalized event log found in receipt",
      );
    }

    if (decoded.event.taskId.toLowerCase() !== params.expectedTaskIdOnChain.toLowerCase()) {
      return mismatch(
        `event taskId ${decoded.event.taskId} does not match expected ${params.expectedTaskIdOnChain}`,
      );
    }

    return {
      ok: true,
      decoded,
      confirmations: Number(confirmations),
      blockHash: receipt.blockHash as `0x${string}`,
    };
  } catch (error) {
    return {
      ok: false,
      code: RPC_TEMPORARILY_UNAVAILABLE,
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
}
