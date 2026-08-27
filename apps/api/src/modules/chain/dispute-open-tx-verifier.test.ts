import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "./rpc.client.js";
import { DISPUTE_OPENED_EVENT_ABI } from "./dispute-opened-event.js";
import type { RawEventLog } from "./task-funded-event.js";
import {
  verifyDisputeOpenTransaction,
  type VerifyDisputeOpenTransactionParams,
} from "./dispute-open-tx-verifier.js";

const TX_HASH = ("0x" + "a".repeat(64)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a" as `0x${string}`;
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" as `0x${string}`;
const TASK_ID_ON_CHAIN = ("0x" + "1".repeat(64)) as `0x${string}`;
const EVIDENCE_HASH = ("0x" + "c".repeat(64)) as `0x${string}`;
const EXPECTED_CHAIN_ID = 31337;
const RECEIPT_BLOCK_NUMBER = 100n;
const REQUIRED_CONFIRMATIONS = 3;
const CONFIRMED_CURRENT_BLOCK_NUMBER = RECEIPT_BLOCK_NUMBER + BigInt(REQUIRED_CONFIRMATIONS) - 1n;

function buildDisputeOpenedLog(
  overrides: { taskId?: `0x${string}`; evidenceHash?: `0x${string}` } = {},
): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const evidenceHash = overrides.evidenceHash ?? EVIDENCE_HASH;
  const topics = encodeEventTopics({
    abi: DISPUTE_OPENED_EVENT_ABI,
    eventName: "DisputeOpened",
    args: { taskId, requester: getAddress(REQUESTER_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [{ name: "disputeEvidenceHash", type: "bytes32" }],
    [evidenceHash],
  );
  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildReceipt(overrides: Partial<TransactionReceiptResult> = {}): TransactionReceiptResult {
  return {
    status: "success",
    to: TRUSTED_CONTRACT,
    blockNumber: RECEIPT_BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    logs: [buildDisputeOpenedLog()],
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
      throw new Error("not used by dispute-open-tx-verifier");
    },
    async readStakeRateBps() {
      throw new Error("not used by dispute-open-tx-verifier");
    },
    async readAuthorizedSigner() {
      throw new Error("not used by dispute-open-tx-verifier");
    },
    async readHasRole() {
      throw new Error("not used by dispute-open-tx-verifier");
    },
  };
}

function baseParams(
  overrides: Partial<VerifyDisputeOpenTransactionParams> = {},
): VerifyDisputeOpenTransactionParams {
  return {
    rpc: buildFakeRpc(),
    txHash: TX_HASH,
    expectedChainId: EXPECTED_CHAIN_ID,
    trustedContractAddress: TRUSTED_CONTRACT,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    expectedTaskIdOnChain: TASK_ID_ON_CHAIN,
    expectedEvidenceHash: EVIDENCE_HASH,
    ...overrides,
  };
}

describe("verifyDisputeOpenTransaction", () => {
  it("decodes a matching DisputeOpened receipt", async () => {
    const result = await verifyDisputeOpenTransaction(baseParams());
    expect(result.ok).toBe(true);
  });

  it("rejects when the decoded taskId does not match", async () => {
    const otherTaskId = ("0x" + "9".repeat(64)) as `0x${string}`;
    const result = await verifyDisputeOpenTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildDisputeOpenedLog({ taskId: otherTaskId })] }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("rejects when the decoded evidenceHash does not match the recorded dispute's own hash", async () => {
    const otherHash = ("0x" + "d".repeat(64)) as `0x${string}`;
    const result = await verifyDisputeOpenTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildDisputeOpenedLog({ evidenceHash: otherHash })] }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns TRANSACTION_NOT_FOUND when no receipt exists", async () => {
    const result = await verifyDisputeOpenTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: null }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_FOUND");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when confirmations are below the required threshold", async () => {
    const result = await verifyDisputeOpenTransaction(
      baseParams({ rpc: buildFakeRpc({ currentBlockNumber: RECEIPT_BLOCK_NUMBER }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });
});
