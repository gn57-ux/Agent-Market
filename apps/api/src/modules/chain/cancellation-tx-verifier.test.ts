import { describe, expect, it } from "vitest";
import { encodeEventTopics } from "viem";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "./rpc.client.js";
import { TASK_CANCELLED_EVENT_ABI } from "@agent-market/domain";
import type { RawEventLog } from "@agent-market/domain";
import {
  verifyCancellationTransaction,
  type VerifyCancellationTransactionParams,
} from "./cancellation-tx-verifier.js";

const TX_HASH = ("0x" + "a".repeat(64)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a" as `0x${string}`;
const TASK_ID_ON_CHAIN = ("0x" + "1".repeat(64)) as `0x${string}`;
const EXPECTED_CHAIN_ID = 31337;
const RECEIPT_BLOCK_NUMBER = 100n;
const REQUIRED_CONFIRMATIONS = 3;
const CONFIRMED_CURRENT_BLOCK_NUMBER = RECEIPT_BLOCK_NUMBER + BigInt(REQUIRED_CONFIRMATIONS) - 1n;

function buildTaskCancelledLog(overrides: { taskId?: `0x${string}` } = {}): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const topics = encodeEventTopics({
    abi: TASK_CANCELLED_EVENT_ABI,
    eventName: "TaskCancelled",
    args: { taskId },
  }) as readonly string[];
  return { address: TRUSTED_CONTRACT, topics, data: "0x", logIndex: 0 };
}

function buildReceipt(overrides: Partial<TransactionReceiptResult> = {}): TransactionReceiptResult {
  return {
    status: "success",
    to: TRUSTED_CONTRACT,
    blockNumber: RECEIPT_BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    logs: [buildTaskCancelledLog()],
    ...overrides,
  };
}

function buildFakeRpc(
  options: {
    receipt?: TransactionReceiptResult | null;
    chainId?: number;
    currentBlockNumber?: bigint;
    canonicalBlock?: BlockResult | null;
  } = {},
): ChainRpcClient {
  const {
    receipt = buildReceipt(),
    chainId = EXPECTED_CHAIN_ID,
    currentBlockNumber = CONFIRMED_CURRENT_BLOCK_NUMBER,
    canonicalBlock = { hash: BLOCK_HASH, number: RECEIPT_BLOCK_NUMBER },
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
      throw new Error("not used by cancellation-tx-verifier");
    },
    async readStakeRateBps() {
      throw new Error("not used by cancellation-tx-verifier");
    },
    async readAuthorizedSigner() {
      throw new Error("not used by cancellation-tx-verifier");
    },
    async readHasRole() {
      throw new Error("not used by cancellation-tx-verifier");
    },
  };
}

function baseParams(
  overrides: Partial<VerifyCancellationTransactionParams> = {},
): VerifyCancellationTransactionParams {
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

describe("verifyCancellationTransaction", () => {
  it("decodes a matching TaskCancelled receipt", async () => {
    const result = await verifyCancellationTransaction(baseParams());
    expect(result.ok).toBe(true);
  });

  it("rejects when the decoded taskId does not match", async () => {
    const otherTaskId = ("0x" + "9".repeat(64)) as `0x${string}`;
    const result = await verifyCancellationTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildTaskCancelledLog({ taskId: otherTaskId })] }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("rejects when no TaskCancelled log is present", async () => {
    const result = await verifyCancellationTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ logs: [] }) }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns TRANSACTION_NOT_FOUND when no receipt exists", async () => {
    const result = await verifyCancellationTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: null }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_FOUND");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when confirmations are below the required threshold", async () => {
    const result = await verifyCancellationTransaction(
      baseParams({ rpc: buildFakeRpc({ currentBlockNumber: RECEIPT_BLOCK_NUMBER }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("rejects when the transaction status is not success", async () => {
    const result = await verifyCancellationTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ status: "reverted" }) }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("rejects when the receipt's `to` is not the trusted contract", async () => {
    const result = await verifyCancellationTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ to: "0x000000000000000000000000000000000000dead" }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });
});
