import type { ErrorCode } from "@agent-market/domain";
import type { ChainRpcClient } from "./rpc.client.js";
import { findResultSubmittedLog } from "@agent-market/domain";

// Same bind-every-code-to-a-const discipline as tx-verifier.ts/
// acceptance-tx-verifier.ts. No new ErrorCode is introduced for a decoded
// `ResultSubmitted` event that doesn't match what this request expected —
// `packages/domain`'s ERROR_CODES is PRD §11.4's closed, test-locked list,
// so this reuses `FUNDING_EVENT_MISMATCH`, the same "closest existing code"
// choice `acceptance-tx-verifier.ts` already made for the identical
// situation.
const CHAIN_UNSUPPORTED: ErrorCode = "CHAIN_UNSUPPORTED";
const TRANSACTION_NOT_FOUND: ErrorCode = "TRANSACTION_NOT_FOUND";
const TRANSACTION_NOT_CONFIRMED: ErrorCode = "TRANSACTION_NOT_CONFIRMED";
const EVENT_MISMATCH: ErrorCode = "FUNDING_EVENT_MISMATCH";
const RPC_TEMPORARILY_UNAVAILABLE: ErrorCode = "RPC_TEMPORARILY_UNAVAILABLE";

/** What this backend expects a verified `ResultSubmitted` event to
 * contain — mirrors `acceptance-tx-verifier.ts`'s
 * `AcceptanceVerificationExpectation` boundary. Unlike that verifier, there
 * is no independent stake/nonce cross-check here: `TaskEscrow.submitResult`
 * (contracts/src/TaskEscrow.sol) already enforces `task.agent == msg.sender`
 * on-chain, so a decoded event's `agent` field is guaranteed to be the
 * task's actual accepted Agent — nothing here needs to re-derive that. */
export interface ResultSubmissionVerificationExpectation {
  /** bytes32 on-chain task id (`onchain-task-id.ts`'s `deriveOnChainTaskId`
   * applied to `tasks.id`). */
  taskIdOnChain: `0x${string}`;
  /** The caller's own session wallet address — `submitResult` reverts
   * unless `msg.sender == task.agent`, so the event's `agent` field is
   * expected to equal whoever is submitting this txHash for verification,
   * exactly as `acceptance-tx-verifier.ts` expects for `TaskAccepted`. */
  agentAddress: `0x${string}`;
}

export interface VerifyResultSubmissionTransactionParams {
  rpc: ChainRpcClient;
  txHash: `0x${string}`;
  expectedChainId: number;
  trustedContractAddress: `0x${string}`;
  requiredConfirmations: number;
  expected: ResultSubmissionVerificationExpectation;
}

export interface VerifiedResultSubmissionEvent {
  taskId: `0x${string}`;
  agent: `0x${string}`;
  resultHash: `0x${string}`;
  /** Unix seconds, exactly as the contract computed and emitted them
   * (TaskEscrow.sol's `submitResult`) — the service layer converts these
   * to `Date` verbatim, no `+ reviewWindow` arithmetic anywhere in this
   * codebase outside the contract itself (design.md F-905/AC-908). */
  submittedAt: bigint;
  reviewDeadline: bigint;
}

export type ResultSubmissionVerificationResult =
  | {
      ok: true;
      event: VerifiedResultSubmissionEvent;
      confirmations: number;
      blockHash: `0x${string}`;
    }
  | { ok: false; code: ErrorCode; message: string };

function mismatch(message: string): ResultSubmissionVerificationResult {
  return { ok: false, code: EVENT_MISMATCH, message };
}

function notConfirmed(message: string): ResultSubmissionVerificationResult {
  return { ok: false, code: TRANSACTION_NOT_CONFIRMED, message };
}

/**
 * T-905's RPC-only, database-free verification of a `submitResult`
 * transaction — structured identically to `tx-verifier.ts`'s
 * `verifyFundingTransaction` and `acceptance-tx-verifier.ts`'s
 * `verifyAcceptanceTransaction` (same check order, same error-code
 * discipline):
 *
 *   1. receipt exists                        → else TRANSACTION_NOT_FOUND
 *   2. chainId matches the configured chain   → else CHAIN_UNSUPPORTED
 *   3. receipt status is success              → else TRANSACTION_NOT_CONFIRMED
 *   4. confirmations reached AND the block at
 *      that height is still canonical         → else TRANSACTION_NOT_CONFIRMED
 *   5. receipt `to` is the trusted contract   → else FUNDING_EVENT_MISMATCH (reused)
 *   6. a `ResultSubmitted` log decodes        → else FUNDING_EVENT_MISMATCH (reused)
 *   7. decoded taskId/agent match expected    → else FUNDING_EVENT_MISMATCH (reused)
 *
 * Any unexpected RPC error is caught and turned into
 * `RPC_TEMPORARILY_UNAVAILABLE`, never a thrown exception — same reasoning
 * as the other two verifiers: the caller must be able to treat every
 * outcome uniformly as data, so a flaky RPC leaves the task `ACCEPTED`
 * ("待确认"), not wrongly marked failed.
 */
export async function verifyResultSubmissionTransaction(
  params: VerifyResultSubmissionTransactionParams,
): Promise<ResultSubmissionVerificationResult> {
  const { rpc, txHash, expectedChainId, trustedContractAddress, requiredConfirmations, expected } =
    params;

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

    const decoded = findResultSubmittedLog(receipt.logs, trustedContractAddress);
    if (!decoded) {
      return mismatch("no ResultSubmitted event log found in receipt");
    }

    if (decoded.taskId.toLowerCase() !== expected.taskIdOnChain.toLowerCase()) {
      return mismatch(
        `event taskId ${decoded.taskId} does not match expected ${expected.taskIdOnChain}`,
      );
    }
    if (decoded.agent.toLowerCase() !== expected.agentAddress.toLowerCase()) {
      return mismatch(
        `event agent ${decoded.agent} does not match the submitting session address ${expected.agentAddress}`,
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
