import type { ErrorCode } from "@agent-market/domain";
import type { ChainRpcClient } from "./rpc.client.js";
import { findDisputeOpenedLog } from "@agent-market/domain";

// Same bind-every-code-to-a-const discipline as every other verifier in
// this codebase.
const CHAIN_UNSUPPORTED: ErrorCode = "CHAIN_UNSUPPORTED";
const TRANSACTION_NOT_FOUND: ErrorCode = "TRANSACTION_NOT_FOUND";
const TRANSACTION_NOT_CONFIRMED: ErrorCode = "TRANSACTION_NOT_CONFIRMED";
const EVENT_MISMATCH: ErrorCode = "FUNDING_EVENT_MISMATCH";
const RPC_TEMPORARILY_UNAVAILABLE: ErrorCode = "RPC_TEMPORARILY_UNAVAILABLE";

export interface VerifyDisputeOpenTransactionParams {
  rpc: ChainRpcClient;
  txHash: `0x${string}`;
  expectedChainId: number;
  trustedContractAddress: `0x${string}`;
  requiredConfirmations: number;
  expectedTaskIdOnChain: `0x${string}`;
  /** The dispute's own recorded evidence hash (`disputes.evidence_hash`,
   * the open dispute row `verifyDisputeOpen` looked up before calling
   * this) — cross-checked against the decoded event's own
   * `disputeEvidenceHash` so an on-chain dispute can never be accepted
   * for a DIFFERENT piece of off-chain evidence than the one this backend
   * actually has on file for the arbitrator to review. */
  expectedEvidenceHash: `0x${string}`;
}

export interface VerifiedDisputeOpenedEvent {
  taskId: `0x${string}`;
  requester: `0x${string}`;
  disputeEvidenceHash: `0x${string}`;
}

export type DisputeOpenVerificationResult =
  | { ok: true; event: VerifiedDisputeOpenedEvent; confirmations: number; blockHash: `0x${string}` }
  | { ok: false; code: ErrorCode; message: string };

function mismatch(message: string): DisputeOpenVerificationResult {
  return { ok: false, code: EVENT_MISMATCH, message };
}

function notConfirmed(message: string): DisputeOpenVerificationResult {
  return { ok: false, code: TRANSACTION_NOT_CONFIRMED, message };
}

/**
 * RPC-only, database-free verification of an `openDispute` transaction —
 * same check order/error-code discipline as every other verifier in this
 * codebase, with one extra check no other verifier has: the decoded
 * event's `disputeEvidenceHash` must match what `POST /tasks/:taskId/disputes`
 * already recorded (`expectedEvidenceHash`) — otherwise a caller could
 * open a real, confirmed on-chain dispute whose evidence hash has nothing
 * to do with the off-chain reason/evidence text an arbitrator would
 * actually review.
 */
export async function verifyDisputeOpenTransaction(
  params: VerifyDisputeOpenTransactionParams,
): Promise<DisputeOpenVerificationResult> {
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

    const decoded = findDisputeOpenedLog(receipt.logs, trustedContractAddress);
    if (!decoded) {
      return mismatch("no DisputeOpened event log found in receipt");
    }

    if (decoded.taskId.toLowerCase() !== params.expectedTaskIdOnChain.toLowerCase()) {
      return mismatch(
        `event taskId ${decoded.taskId} does not match expected ${params.expectedTaskIdOnChain}`,
      );
    }
    if (decoded.disputeEvidenceHash.toLowerCase() !== params.expectedEvidenceHash.toLowerCase()) {
      return mismatch(
        `event disputeEvidenceHash ${decoded.disputeEvidenceHash} does not match the recorded ` +
          `dispute's evidence hash ${params.expectedEvidenceHash}`,
      );
    }

    return {
      ok: true,
      event: decoded,
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
