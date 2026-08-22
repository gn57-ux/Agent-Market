import type { ErrorCode } from "@agent-market/domain";
import type { Queryable } from "../../db/pool.js";
import type { ChainRpcClient } from "./rpc.client.js";
import { findTaskFundedLog } from "./task-funded-event.js";

// Every ErrorCode this module can return is bound to a `const` up front
// (matching apps/api/src/modules/auth/routes.ts's `WALLET_SIGNATURE_INVALID`
// pattern) — no bare string literal stands in for one of these anywhere
// below.
const CHAIN_UNSUPPORTED: ErrorCode = "CHAIN_UNSUPPORTED";
const TRANSACTION_NOT_FOUND: ErrorCode = "TRANSACTION_NOT_FOUND";
const TRANSACTION_NOT_CONFIRMED: ErrorCode = "TRANSACTION_NOT_CONFIRMED";
const FUNDING_EVENT_MISMATCH: ErrorCode = "FUNDING_EVENT_MISMATCH";
const TRANSACTION_ALREADY_USED: ErrorCode = "TRANSACTION_ALREADY_USED";
const RPC_TEMPORARILY_UNAVAILABLE: ErrorCode = "RPC_TEMPORARILY_UNAVAILABLE";

/** What the draft (`tasks` row) says the on-chain `TaskFunded` event ought
 * to contain, in the exact units each field is compared in — this is the
 * boundary where callers (the future `funding-verifications` service
 * layer) translate their own row shape into what this deep module needs,
 * so this module never has to know about `TaskRow`/Postgres column types. */
export interface FundingVerificationExpectation {
  /** bytes32 on-chain task id, as computed by the funding-intent step
   * (T-604, out of this task's scope) — NOT the `tasks.id` UUID directly. */
  taskIdOnChain: `0x${string}`;
  requesterAddress: `0x${string}`;
  token: `0x${string}`;
  /** Minimal-unit unsigned integer string (F-609) — compared as a `BigInt`,
   * never converted to a JS `number`, so no precision is lost for budgets
   * beyond `Number.MAX_SAFE_INTEGER`. */
  budget: string;
  /** `tasks.delivery_deadline` (TIMESTAMPTZ) as a JS `Date` — this module
   * converts it to whole unix seconds itself (see `toUnixSeconds` below) to
   * compare against the on-chain `uint64 deliveryDeadline`, which is
   * seconds, not milliseconds. Callers must NOT pre-convert. */
  deliveryDeadline: Date;
}

export interface VerifyFundingTransactionParams {
  rpc: ChainRpcClient;
  txHash: `0x${string}`;
  /** The chain this backend is configured to trust for this deployment
   * (from `resolveChainConfig`/env at the call site — this module never
   * resolves chain config itself, so its tests never need a real deployed
   * contract address to exist; see the capsule's note on
   * `chain-config.ts` throwing without one). */
  expectedChainId: number;
  trustedContractAddress: `0x${string}`;
  /** Number of blocks (inclusive of the transaction's own block) required
   * before a transaction is considered confirmed. */
  requiredConfirmations: number;
  expected: FundingVerificationExpectation;
}

export interface VerifiedFundingEvent {
  taskId: `0x${string}`;
  requester: `0x${string}`;
  token: `0x${string}`;
  budget: bigint;
  deliveryDeadline: bigint;
}

export type FundingVerificationResult =
  | { ok: true; event: VerifiedFundingEvent; confirmations: number; blockHash: `0x${string}` }
  | { ok: false; code: ErrorCode; message: string };

function toUnixSeconds(date: Date): bigint {
  return BigInt(Math.floor(date.getTime() / 1000));
}

function mismatch(message: string): FundingVerificationResult {
  return { ok: false, code: FUNDING_EVENT_MISMATCH, message };
}

function notConfirmed(message: string): FundingVerificationResult {
  return { ok: false, code: TRANSACTION_NOT_CONFIRMED, message };
}

/**
 * F-605's deep module: every independent-RPC check the PRD requires before
 * a funding transaction is trusted lives here, in this order —
 *
 *   1. receipt exists                        → else TRANSACTION_NOT_FOUND
 *   2. chainId matches the configured chain   → else CHAIN_UNSUPPORTED
 *   3. receipt status is success              → else TRANSACTION_NOT_CONFIRMED
 *   4. confirmations reached AND the block at
 *      that height is still canonical         → else TRANSACTION_NOT_CONFIRMED
 *   5. receipt `to` is the trusted contract   → else FUNDING_EVENT_MISMATCH
 *   6. a `TaskFunded` log decodes from it     → else FUNDING_EVENT_MISMATCH
 *   7. every decoded field matches the draft  → else FUNDING_EVENT_MISMATCH
 *
 * Any unexpected error from the RPC client (network failure, timeout, node
 * error — not a business outcome the client encodes as `null`/a receipt
 * field) is caught here and turned into `RPC_TEMPORARILY_UNAVAILABLE`,
 * never a thrown exception — F-606 requires that a flaky RPC leaves the
 * task "待确认", which only works if the caller (the route/service layer)
 * can treat every outcome of this function uniformly as data, not control
 * flow via try/catch.
 *
 * `TRANSACTION_ALREADY_USED` is deliberately NOT decided in this function
 * — see `checkTransactionNotUsed` below for why that one check is split
 * into its own function with its own boundary.
 */
export async function verifyFundingTransaction(
  params: VerifyFundingTransactionParams,
): Promise<FundingVerificationResult> {
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

    // "区块哈希可查询" (F-605): re-fetch the canonical block at the
    // receipt's height and confirm its hash still matches the receipt's
    // `blockHash`. A mismatch (or the block no longer resolving at all)
    // means the block the transaction was mined in has been reorged out —
    // the transaction is no longer confirmed on the canonical chain, even
    // though the receipt object itself still exists. This is the same
    // canonical-block check `event-sync.ts`'s reorg rollback reuses.
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

    const decoded = findTaskFundedLog(receipt.logs, trustedContractAddress);
    if (!decoded) {
      return mismatch("no TaskFunded event log found in receipt");
    }

    if (decoded.taskId.toLowerCase() !== expected.taskIdOnChain.toLowerCase()) {
      return mismatch(
        `event taskId ${decoded.taskId} does not match expected ${expected.taskIdOnChain}`,
      );
    }
    if (decoded.requester.toLowerCase() !== expected.requesterAddress.toLowerCase()) {
      return mismatch(
        `event requester ${decoded.requester} does not match expected ${expected.requesterAddress}`,
      );
    }
    if (decoded.token.toLowerCase() !== expected.token.toLowerCase()) {
      return mismatch(`event token ${decoded.token} does not match expected ${expected.token}`);
    }
    const expectedBudget = BigInt(expected.budget);
    if (decoded.budget !== expectedBudget) {
      return mismatch(
        `event budget ${decoded.budget.toString()} does not match expected ${expectedBudget.toString()}`,
      );
    }
    const expectedDeadline = toUnixSeconds(expected.deliveryDeadline);
    if (decoded.deliveryDeadline !== expectedDeadline) {
      return mismatch(
        `event deliveryDeadline ${decoded.deliveryDeadline.toString()} (unix seconds) does not ` +
          `match expected ${expectedDeadline.toString()}`,
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

export interface TransactionUsageCheckResult {
  ok: boolean;
  code?: ErrorCode;
  message?: string;
}

/**
 * F-605's "交易哈希未绑定其他任务" check, split out from
 * `verifyFundingTransaction` on purpose: that function is a pure,
 * RPC-only judgment with no database dependency, which is what makes its
 * unit tests fast and independent of any database. Whether a `(chainId,
 * txHash)` pair is already claimed by a *different* task is a question
 * about this backend's own `chain_transactions` table (its `UNIQUE
 * (chain_id, tx_hash)` constraint, 0005_create_tasks.sql), not about the
 * chain itself — so it belongs in its own function with its own boundary,
 * called by the service layer strictly *after* `verifyFundingTransaction`
 * returns `ok: true` (no point spending a DB round-trip verifying
 * uniqueness for an event that didn't even match).
 *
 * Idempotent: a row already bound to the *same* `taskId` is not a
 * conflict — F-606 requires "复核逻辑幂等，可重复执行不产生重复结果", so
 * re-verifying a transaction that this task itself already recorded must
 * succeed, not fail as "already used".
 */
export async function checkTransactionNotUsed(
  db: Queryable,
  chainId: number,
  txHash: string,
  taskId: string,
): Promise<TransactionUsageCheckResult> {
  // Hex hashes are case-insensitive, but `chain_transactions.tx_hash`'s own
  // CHECK constraint (0005_create_tasks.sql) only ever admits lowercase
  // hex — every row in the table is guaranteed lowercase. `txHash` here
  // comes from the caller's request body (arbitrary case), so without
  // normalizing it first, a mixed-case resubmission of an already-used
  // hash would miss this row entirely and this function would wrongly
  // return `ok: true`, letting `TRANSACTION_ALREADY_USED` be bypassed
  // (Codex review, T-603 round 1, P2).
  const normalizedTxHash = txHash.toLowerCase();
  const result = await db.query<{ task_id: string }>(
    "SELECT task_id FROM chain_transactions WHERE chain_id = $1 AND tx_hash = $2",
    [chainId, normalizedTxHash],
  );

  const existing = result.rows[0];
  if (!existing || existing.task_id === taskId) {
    return { ok: true };
  }

  return {
    ok: false,
    code: TRANSACTION_ALREADY_USED,
    message: `tx ${normalizedTxHash} on chain ${chainId} is already bound to task ${existing.task_id}`,
  };
}
