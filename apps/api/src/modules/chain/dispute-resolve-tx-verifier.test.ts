import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "./rpc.client.js";
import { DISPUTE_RESOLVED_EVENT_ABI } from "@agent-market/domain";
import type { RawEventLog } from "@agent-market/domain";
import {
  verifyDisputeResolveTransaction,
  type VerifyDisputeResolveTransactionParams,
} from "./dispute-resolve-tx-verifier.js";

const TX_HASH = ("0x" + "a".repeat(64)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a" as `0x${string}`;
const ARBITRATOR_ADDRESS = "0x2222222222222222222222222222222222222b" as `0x${string}`;
const TASK_ID_ON_CHAIN = ("0x" + "1".repeat(64)) as `0x${string}`;
const EXPECTED_CHAIN_ID = 31337;
const RECEIPT_BLOCK_NUMBER = 100n;
const REQUIRED_CONFIRMATIONS = 3;
const CONFIRMED_CURRENT_BLOCK_NUMBER = RECEIPT_BLOCK_NUMBER + BigInt(REQUIRED_CONFIRMATIONS) - 1n;

function buildDisputeResolvedLog(
  overrides: { taskId?: `0x${string}`; supportAgent?: boolean } = {},
): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const topics = encodeEventTopics({
    abi: DISPUTE_RESOLVED_EVENT_ABI,
    eventName: "DisputeResolved",
    args: { taskId },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [{ name: "supportAgent", type: "bool" }],
    [overrides.supportAgent ?? true],
  );
  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildReceipt(overrides: Partial<TransactionReceiptResult> = {}): TransactionReceiptResult {
  return {
    status: "success",
    to: TRUSTED_CONTRACT,
    blockNumber: RECEIPT_BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    logs: [buildDisputeResolvedLog()],
    ...overrides,
  };
}

function buildFakeRpc(
  options: {
    receipt?: TransactionReceiptResult | null;
    chainId?: number;
    currentBlockNumber?: bigint;
    canonicalBlock?: BlockResult | null;
    transactionFrom?: `0x${string}` | null;
  } = {},
): ChainRpcClient {
  const {
    receipt = buildReceipt(),
    chainId = EXPECTED_CHAIN_ID,
    currentBlockNumber = CONFIRMED_CURRENT_BLOCK_NUMBER,
    canonicalBlock = { hash: BLOCK_HASH, number: RECEIPT_BLOCK_NUMBER },
    transactionFrom = ARBITRATOR_ADDRESS,
  } = options;
  return {
    async getTransactionReceipt() {
      return receipt;
    },
    async getBlockNumber() {
      return currentBlockNumber;
    },
    async getBlock() {
      return canonicalBlock;
    },
    async getChainId() {
      return chainId;
    },
    async getTransaction() {
      if (transactionFrom === null) {
        return null;
      }
      return { input: "0x", from: transactionFrom };
    },
    async readStakeRateBps() {
      throw new Error("not used by dispute-resolve-tx-verifier");
    },
    async readAuthorizedSigner() {
      throw new Error("not used by dispute-resolve-tx-verifier");
    },
    async readHasRole() {
      throw new Error("not used by dispute-resolve-tx-verifier");
    },
  };
}

function baseParams(
  overrides: Partial<VerifyDisputeResolveTransactionParams> = {},
): VerifyDisputeResolveTransactionParams {
  return {
    rpc: buildFakeRpc(),
    txHash: TX_HASH,
    expectedChainId: EXPECTED_CHAIN_ID,
    trustedContractAddress: TRUSTED_CONTRACT,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    expectedTaskIdOnChain: TASK_ID_ON_CHAIN,
    ...overrides,
  };
}

describe("verifyDisputeResolveTransaction", () => {
  it("decodes a DisputeResolved receipt with supportAgent = true, and returns the tx sender as resolvedBy", async () => {
    const result = await verifyDisputeResolveTransaction(baseParams());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.supportAgent).toBe(true);
      expect(result.resolvedBy).toBe(ARBITRATOR_ADDRESS);
    }
  });

  it("returns TRANSACTION_NOT_FOUND when the receipt exists but the transaction itself cannot be fetched", async () => {
    const result = await verifyDisputeResolveTransaction(
      baseParams({ rpc: buildFakeRpc({ transactionFrom: null }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_FOUND");
  });

  it("decodes a DisputeResolved receipt with supportAgent = false", async () => {
    const result = await verifyDisputeResolveTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildDisputeResolvedLog({ supportAgent: false })] }),
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.supportAgent).toBe(false);
  });

  it("rejects when the decoded taskId does not match", async () => {
    const otherTaskId = ("0x" + "9".repeat(64)) as `0x${string}`;
    const result = await verifyDisputeResolveTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildDisputeResolvedLog({ taskId: otherTaskId })] }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns TRANSACTION_NOT_FOUND when no receipt exists", async () => {
    const result = await verifyDisputeResolveTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: null }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_FOUND");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the block is no longer canonical (reorg)", async () => {
    const result = await verifyDisputeResolveTransaction(
      baseParams({
        rpc: buildFakeRpc({
          canonicalBlock: {
            hash: ("0x" + "f".repeat(64)) as `0x${string}`,
            number: RECEIPT_BLOCK_NUMBER,
          },
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });
});
