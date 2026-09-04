import type { ErrorCode } from "@agent-market/domain";
import type { ChainRpcClient } from "./rpc.client.js";
import { findTaskCancelledLog } from "@agent-market/domain";

// Same bind-every-code-to-a-const discipline as every other verifier in
// this codebase.
const CHAIN_UNSUPPORTED: ErrorCode = "CHAIN_UNSUPPORTED";
const TRANSACTION_NOT_FOUND: ErrorCode = "TRANSACTION_NOT_FOUND";
const TRANSACTION_NOT_CONFIRMED: ErrorCode = "TRANSACTION_NOT_CONFIRMED";
const EVENT_MISMATCH: ErrorCode = "FUNDING_EVENT_MISMATCH";
const RPC_TEMPORARILY_UNAVAILABLE: ErrorCode = "RPC_TEMPORARILY_UNAVAILABLE";

export interface VerifyCancellationTransactionParams {
  rpc: ChainRpcClient;
  txHash: `0x${string}`;
  expectedChainId: number;
  trustedContractAddress: `0x${string}`;
  requiredConfirmations: number;
  expectedTaskIdOnChain: `0x${string}`;
}

export interface VerifiedTaskCancelledEvent {
  taskId: `0x${string}`;
}

export type CancellationVerificationResult =
  | { ok: true; event: VerifiedTaskCancelledEvent; confirmations: number; blockHash: `0x${string}` }
  | { ok: false; code: ErrorCode; message: string };

function mismatch(message: string): CancellationVerificationResult {
  return { ok: false, code: EVENT_MISMATCH, message };
}

function notConfirmed(message: string): CancellationVerificationResult {
  return { ok: false, code: TRANSACTION_NOT_CONFIRMED, message };
}

/**
 * RPC-only, database-free verification of a `cancelTask` transaction —
 * same check order/error-code discipline as `verifyDisputeOpenTransaction`,
 * minus the extra evidence-hash cross-check (`TaskCancelled` carries no
 * payload beyond `taskId`).
 */
export async function verifyCancellationTransaction(
  params: VerifyCancellationTransactionParams,
): Promise<CancellationVerificationResult> {
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

    const decoded = findTaskCancelledLog(receipt.logs, trustedContractAddress);
    if (!decoded) {
      return mismatch("no TaskCancelled event log found in receipt");
    }

    if (decoded.taskId.toLowerCase() !== params.expectedTaskIdOnChain.toLowerCase()) {
      return mismatch(
        `event taskId ${decoded.taskId} does not match expected ${params.expectedTaskIdOnChain}`,
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
