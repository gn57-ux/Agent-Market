import type { ErrorCode } from "@agent-market/domain";
import { decodeFunctionData } from "viem";
import type { ChainRpcClient } from "./rpc.client.js";
import { findTaskAcceptedLog } from "@agent-market/domain";
import { TASK_ESCROW_ACCEPT_TASK_ABI } from "./task-escrow-accept-abi.js";

/**
 * BPS denominator for the stake-rate calculation below — a literal, not
 * read from chain: `TaskEscrow.BPS_DENOMINATOR` is `private` and has no
 * public getter (contracts/src/TaskEscrow.sol), matching
 * `apps/web`'s already-confirmed identical reasoning (task-escrow-accept-
 * abi.ts's header comment) — it's a generic BPS denominator, not a business
 * rule this Feature owns.
 */
const BPS_DENOMINATOR = 10_000n;

/**
 * Decodes `TaskEscrow.acceptTask`'s calldata to recover the exact `nonce`
 * used by the actual on-chain transaction (T-806) — the ONLY reliable way
 * to know which of possibly several outstanding permits for the same
 * wallet was the one actually consumed, since the `TaskAccepted` event
 * itself carries no nonce. Returns `null` (never throws) when `input`
 * doesn't decode as a call to `acceptTask` at all — routine for calldata
 * this module doesn't control the shape of, mirroring
 * `decodeTaskAcceptedLog`'s identical "not a match" contract.
 */
export function decodeAcceptTaskCalldata(input: `0x${string}`): { nonce: bigint } | null {
  try {
    const decoded = decodeFunctionData({ abi: TASK_ESCROW_ACCEPT_TASK_ABI, data: input });
    if (decoded.functionName !== "acceptTask") {
      return null;
    }
    const [permit] = decoded.args;
    return { nonce: permit.nonce };
  } catch {
    return null;
  }
}

// Same bind-every-code-to-a-const discipline as tx-verifier.ts. No new
// ErrorCode is introduced for the "decoded TaskAccepted event doesn't match
// what this request expected" case — `packages/domain`'s ERROR_CODES is
// PRD §11.4's closed, test-locked list (`error-codes.test.ts` asserts "no
// extras, no omissions"), so this module reuses `FUNDING_EVENT_MISMATCH`
// for that case, the same way `tx-verifier.ts` uses it for every
// "chain-event-verification mismatch" outcome regardless of which specific
// field didn't match — not literally "funding," but the closest existing
// code for "an on-chain event this backend independently verified doesn't
// match the expected task/participant."
const CHAIN_UNSUPPORTED: ErrorCode = "CHAIN_UNSUPPORTED";
const TRANSACTION_NOT_FOUND: ErrorCode = "TRANSACTION_NOT_FOUND";
const TRANSACTION_NOT_CONFIRMED: ErrorCode = "TRANSACTION_NOT_CONFIRMED";
const EVENT_MISMATCH: ErrorCode = "FUNDING_EVENT_MISMATCH";
const RPC_TEMPORARILY_UNAVAILABLE: ErrorCode = "RPC_TEMPORARILY_UNAVAILABLE";

/** What this backend expects a verified `TaskAccepted` event to contain —
 * mirrors `tx-verifier.ts`'s `FundingVerificationExpectation` boundary: the
 * service layer translates its own row/session shape into this before
 * calling, so this module never needs to know about `TaskRow`/session
 * cookies. */
export interface AcceptanceVerificationExpectation {
  /** bytes32 on-chain task id (`onchain-task-id.ts`'s `deriveOnChainTaskId`
   * applied to `tasks.id`). */
  taskIdOnChain: `0x${string}`;
  /** The caller's own session wallet address — `TaskEscrow.acceptTask`
   * reverts unless `permit.agent == msg.sender`, so the event's `agent`
   * field is expected to equal whoever is submitting this txHash for
   * verification, exactly as `tasks/service.ts`'s `verifyFunding` expects
   * the event's `requester` to equal the session address that created the
   * draft. */
  agentAddress: `0x${string}`;
  /** The task's escrow budget (decimal-string `uint256`, `TaskRow.budget`)
   * — used for the independent stake-rate cross-check below (T-806, user's
   * item #6): `stake` on-chain must equal `budget * STAKE_RATE_BPS / 10000`,
   * verified here against a value this backend reads independently from
   * the contract, not merely trusted from the event. */
  budget: string;
}

export interface VerifyAcceptanceTransactionParams {
  rpc: ChainRpcClient;
  txHash: `0x${string}`;
  expectedChainId: number;
  trustedContractAddress: `0x${string}`;
  requiredConfirmations: number;
  expected: AcceptanceVerificationExpectation;
}

export interface VerifiedAcceptanceEvent {
  taskId: `0x${string}`;
  agent: `0x${string}`;
  stake: bigint;
  /** The exact `AcceptancePermit.nonce` this transaction's calldata was
   * built with (T-806) — decoded independently from the transaction itself
   * (`rpc.getTransaction` + `decodeAcceptTaskCalldata`), never from the
   * event log (which carries no nonce at all). This is what lets
   * `resolveAcceptingAgentId` (dispatch/repository.ts) identify EXACTLY
   * which issued permit — and therefore which candidate Agent — this
   * acceptance belongs to, with no guessing. */
  nonce: bigint;
}

export type AcceptanceVerificationResult =
  | { ok: true; event: VerifiedAcceptanceEvent; confirmations: number; blockHash: `0x${string}` }
  | { ok: false; code: ErrorCode; message: string };

function mismatch(message: string): AcceptanceVerificationResult {
  return { ok: false, code: EVENT_MISMATCH, message };
}

function notConfirmed(message: string): AcceptanceVerificationResult {
  return { ok: false, code: TRANSACTION_NOT_CONFIRMED, message };
}

/**
 * T-801's RPC-only, database-free verification of a `TaskAccepted`
 * transaction — the acceptance counterpart of `tx-verifier.ts`'s
 * `verifyFundingTransaction`, deliberately structured the same way (same
 * check order, same error-code discipline) so both are read as the same
 * pattern rather than two different designs for the same problem:
 *
 *   1. receipt exists                        → else TRANSACTION_NOT_FOUND
 *   2. chainId matches the configured chain   → else CHAIN_UNSUPPORTED
 *   3. receipt status is success              → else TRANSACTION_NOT_CONFIRMED
 *   4. confirmations reached AND the block at
 *      that height is still canonical         → else TRANSACTION_NOT_CONFIRMED
 *   5. receipt `to` is the trusted contract   → else FUNDING_EVENT_MISMATCH (reused)
 *   6. a `TaskAccepted` log decodes from it   → else FUNDING_EVENT_MISMATCH (reused)
 *   7. decoded taskId/agent match expected    → else FUNDING_EVENT_MISMATCH (reused)
 *   8. the ACTUAL stake matches an indepen-
 *      dently-computed budget*rate/10000     → else FUNDING_EVENT_MISMATCH (reused)
 *   9. the tx's own calldata decodes as
 *      `acceptTask` and carries a nonce       → else FUNDING_EVENT_MISMATCH (reused)
 *
 * Steps 8/9 are T-806's additions (human N6 BLOCK fix, user's items #5/#6):
 * neither is a re-validation of anything the contract itself already
 * checked on-chain — they are this backend's OWN independent confirmation,
 * over its own independent RPC connection, that what actually happened
 * on-chain (the stake actually escrowed, the nonce actually used) is
 * consistent with this task's own expected value and can be traced back to
 * exactly one issued permit.
 *
 * Any unexpected RPC error is caught and turned into
 * `RPC_TEMPORARILY_UNAVAILABLE`, never a thrown exception — same reasoning
 * as `verifyFundingTransaction`: the caller must be able to treat every
 * outcome uniformly as data, so a flaky RPC leaves the task `OPEN`
 * ("待确认"), not wrongly marked failed.
 */
export async function verifyAcceptanceTransaction(
  params: VerifyAcceptanceTransactionParams,
): Promise<AcceptanceVerificationResult> {
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

    const decoded = findTaskAcceptedLog(receipt.logs, trustedContractAddress);
    if (!decoded) {
      return mismatch("no TaskAccepted event log found in receipt");
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

    // Step 8 (T-806, user's item #6): independent stake verification. Reads
    // STAKE_RATE_BPS from the contract over this backend's own RPC
    // connection — never trusts the event's `stake` value on its own — and
    // recomputes the expected stake from this task's own budget, the same
    // `Math.mulDiv`-equivalent floor-division the contract itself performs
    // (contracts/src/TaskEscrow.sol: `Math.mulDiv(task.budget,
    // STAKE_RATE_BPS, BPS_DENOMINATOR)`, which for non-negative integers is
    // exactly `budget * rate / denominator` with BigInt floor division).
    const stakeRateBps = await rpc.readStakeRateBps(trustedContractAddress);
    const expectedStake = (BigInt(expected.budget) * stakeRateBps) / BPS_DENOMINATOR;
    if (decoded.stake !== expectedStake) {
      return mismatch(
        `event stake ${decoded.stake} does not match independently computed expected stake ${expectedStake} (budget ${expected.budget} * STAKE_RATE_BPS ${stakeRateBps} / ${BPS_DENOMINATOR})`,
      );
    }

    // Step 9 (T-806, user's items #1/#2): decode the transaction's OWN
    // calldata (not the receipt/event) to recover the exact nonce used —
    // the only way to unambiguously identify which issued permit this
    // acceptance consumed.
    const transaction = await rpc.getTransaction(txHash);
    if (!transaction) {
      return mismatch(`no transaction found for ${txHash} when decoding acceptTask calldata`);
    }
    const decodedCalldata = decodeAcceptTaskCalldata(transaction.input);
    if (!decodedCalldata) {
      return mismatch(`transaction ${txHash} calldata did not decode as an acceptTask call`);
    }

    return {
      ok: true,
      event: { ...decoded, nonce: decodedCalldata.nonce },
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
