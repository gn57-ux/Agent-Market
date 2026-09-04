import type { ErrorCode } from "@agent-market/domain";
import type { ChainRpcClient } from "./rpc.client.js";
import { findDisputeResolvedLog } from "@agent-market/domain";

const CHAIN_UNSUPPORTED: ErrorCode = "CHAIN_UNSUPPORTED";
const TRANSACTION_NOT_FOUND: ErrorCode = "TRANSACTION_NOT_FOUND";
const TRANSACTION_NOT_CONFIRMED: ErrorCode = "TRANSACTION_NOT_CONFIRMED";
const EVENT_MISMATCH: ErrorCode = "FUNDING_EVENT_MISMATCH";
const RPC_TEMPORARILY_UNAVAILABLE: ErrorCode = "RPC_TEMPORARILY_UNAVAILABLE";

export interface VerifyDisputeResolveTransactionParams {
  rpc: ChainRpcClient;
  txHash: `0x${string}`;
  expectedChainId: number;
  trustedContractAddress: `0x${string}`;
  requiredConfirmations: number;
  expectedTaskIdOnChain: `0x${string}`;
}

export interface VerifiedDisputeResolvedEvent {
  taskId: `0x${string}`;
  supportAgent: boolean;
}

export type DisputeResolveVerificationResult =
  | {
      ok: true;
      event: VerifiedDisputeResolvedEvent;
      confirmations: number;
      blockHash: `0x${string}`;
      /** The transaction's own signer (`from`), NOT the identity of
       * whatever authenticated caller POSTed this txHash to the backend
       * (Codex review, T-1002 round 1, P1: any logged-in user could
       * otherwise report a real, already-mined `resolveDispute`
       * transaction and get themselves recorded as the arbitrator).
       * `resolveDispute` enforces `ARBITRATOR_ROLE` on-chain, so this is
       * the real arbitrator's address whenever `ok: true`. */
      resolvedBy: `0x${string}`;
    }
  | { ok: false; code: ErrorCode; message: string };

function mismatch(message: string): DisputeResolveVerificationResult {
  return { ok: false, code: EVENT_MISMATCH, message };
}

function notConfirmed(message: string): DisputeResolveVerificationResult {
  return { ok: false, code: TRANSACTION_NOT_CONFIRMED, message };
}

/**
 * RPC-only, database-free verification of a `resolveDispute` transaction —
 * same check order/error-code discipline as every other verifier in this
 * codebase. No caller-identity AUTHORIZATION check: `resolveDispute`
 * itself already enforces `ARBITRATOR_ROLE` on-chain (design.md's own
 * explicit decision — "仲裁裁决接口不新增权限校验层"). But the event
 * doesn't carry the arbitrator's address, so this verifier independently
 * reads the transaction's own `from` (via `rpc.getTransaction`) and
 * returns it as `resolvedBy` — the only trustworthy source for "who
 * actually resolved this dispute" (Codex review, T-1002 round 1, P1).
 */
export async function verifyDisputeResolveTransaction(
  params: VerifyDisputeResolveTransactionParams,
): Promise<DisputeResolveVerificationResult> {
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

    const decoded = findDisputeResolvedLog(receipt.logs, trustedContractAddress);
    if (!decoded) {
      return mismatch("no DisputeResolved event log found in receipt");
    }

    if (decoded.taskId.toLowerCase() !== params.expectedTaskIdOnChain.toLowerCase()) {
      return mismatch(
        `event taskId ${decoded.taskId} does not match expected ${params.expectedTaskIdOnChain}`,
      );
    }

    const transaction = await rpc.getTransaction(txHash);
    if (!transaction) {
      return {
        ok: false,
        code: TRANSACTION_NOT_FOUND,
        message: `no transaction found for ${txHash}`,
      };
    }

    return {
      ok: true,
      event: decoded,
      confirmations: Number(confirmations),
      blockHash: receipt.blockHash as `0x${string}`,
      resolvedBy: transaction.from,
    };
  } catch (error) {
    return {
      ok: false,
      code: RPC_TEMPORARILY_UNAVAILABLE,
      message: error instanceof Error ? error.message : "unexpected RPC client error",
    };
  }
}
