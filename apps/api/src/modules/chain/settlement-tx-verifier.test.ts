import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "./rpc.client.js";
import { RESULT_APPROVED_EVENT_ABI } from "@agent-market/domain";
import { DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI } from "@agent-market/domain";
import { REVIEW_TIMEOUT_FINALIZED_EVENT_ABI } from "@agent-market/domain";
import type { RawEventLog } from "@agent-market/domain";
import {
  verifySettlementTransaction,
  type VerifySettlementTransactionParams,
} from "./settlement-tx-verifier.js";

const TX_HASH = ("0x" + "a".repeat(64)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a" as `0x${string}`;
const AGENT_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" as `0x${string}`;
const REQUESTER_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4" as `0x${string}`;
const TASK_ID_ON_CHAIN = ("0x" + "1".repeat(64)) as `0x${string}`;
const BUDGET = 1_000_000_000_000_000_000_000n;
const STAKE = 60_000_000_000_000_000_000n;
const EXPECTED_CHAIN_ID = 31337;
const RECEIPT_BLOCK_NUMBER = 100n;
const REQUIRED_CONFIRMATIONS = 3;
const CONFIRMED_CURRENT_BLOCK_NUMBER = RECEIPT_BLOCK_NUMBER + BigInt(REQUIRED_CONFIRMATIONS) - 1n;

function buildResultApprovedLog(taskId: `0x${string}` = TASK_ID_ON_CHAIN): RawEventLog {
  const topics = encodeEventTopics({
    abi: RESULT_APPROVED_EVENT_ABI,
    eventName: "ResultApproved",
    args: { taskId, agent: getAddress(AGENT_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [BUDGET, STAKE],
  );
  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildDeliveryTimeoutClaimedLog(taskId: `0x${string}` = TASK_ID_ON_CHAIN): RawEventLog {
  const topics = encodeEventTopics({
    abi: DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI,
    eventName: "DeliveryTimeoutClaimed",
    args: { taskId, requester: getAddress(REQUESTER_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [BUDGET, STAKE],
  );
  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildReviewTimeoutFinalizedLog(taskId: `0x${string}` = TASK_ID_ON_CHAIN): RawEventLog {
  const topics = encodeEventTopics({
    abi: REVIEW_TIMEOUT_FINALIZED_EVENT_ABI,
    eventName: "ReviewTimeoutFinalized",
    args: { taskId, agent: getAddress(AGENT_ADDRESS) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [BUDGET, STAKE],
  );
  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildReceipt(overrides: Partial<TransactionReceiptResult> = {}): TransactionReceiptResult {
  return {
    status: "success",
    to: TRUSTED_CONTRACT,
    blockNumber: RECEIPT_BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    logs: [buildResultApprovedLog()],
    ...overrides,
  };
}

interface FakeRpcOptions {
  receipt?: TransactionReceiptResult | null;
  chainId?: number;
  currentBlockNumber?: bigint;
  canonicalBlock?: BlockResult | null;
}

function buildFakeRpc(options: FakeRpcOptions = {}): ChainRpcClient {
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
      throw new Error("getTransaction: not used by settlement-tx-verifier");
    },
    async readStakeRateBps() {
      throw new Error("readStakeRateBps: not used by settlement-tx-verifier");
    },
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by settlement-tx-verifier");
    },
    async readHasRole() {
      throw new Error("readHasRole: not used by settlement-tx-verifier");
    },
  };
}

function baseParams(
  overrides: Partial<VerifySettlementTransactionParams> = {},
): VerifySettlementTransactionParams {
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

describe("verifySettlementTransaction", () => {
  it("decodes a ResultApproved receipt", async () => {
    const result = await verifySettlementTransaction(baseParams());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decoded.kind).toBe("RESULT_APPROVED");
    }
  });

  it("decodes a DeliveryTimeoutClaimed receipt", async () => {
    const result = await verifySettlementTransaction(
      baseParams({
        rpc: buildFakeRpc({ receipt: buildReceipt({ logs: [buildDeliveryTimeoutClaimedLog()] }) }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decoded.kind).toBe("DELIVERY_TIMEOUT_CLAIMED");
    }
  });

  it("decodes a ReviewTimeoutFinalized receipt", async () => {
    const result = await verifySettlementTransaction(
      baseParams({
        rpc: buildFakeRpc({ receipt: buildReceipt({ logs: [buildReviewTimeoutFinalizedLog()] }) }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decoded.kind).toBe("REVIEW_TIMEOUT_FINALIZED");
    }
  });

  it("rejects when the decoded event's taskId does not match the expected task", async () => {
    const otherTaskId = ("0x" + "9".repeat(64)) as `0x${string}`;
    const result = await verifySettlementTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildResultApprovedLog(otherTaskId)] }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("rejects when no settlement event log is found in the receipt", async () => {
    const result = await verifySettlementTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ logs: [] }) }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns TRANSACTION_NOT_FOUND when no receipt exists", async () => {
    const result = await verifySettlementTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: null }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_FOUND");
  });

  it("returns CHAIN_UNSUPPORTED when the RPC reports a different chainId", async () => {
    const result = await verifySettlementTransaction(
      baseParams({ rpc: buildFakeRpc({ chainId: 1 }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CHAIN_UNSUPPORTED");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the receipt status is reverted", async () => {
    const result = await verifySettlementTransaction(
      baseParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ status: "reverted" }) }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when confirmations are below the required threshold", async () => {
    const result = await verifySettlementTransaction(
      baseParams({
        rpc: buildFakeRpc({ currentBlockNumber: RECEIPT_BLOCK_NUMBER }), // only 1 confirmation
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the block is no longer canonical (reorg)", async () => {
    const result = await verifySettlementTransaction(
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

  it("returns FUNDING_EVENT_MISMATCH when receipt.to is not the trusted contract", async () => {
    const result = await verifySettlementTransaction(
      baseParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ to: "0x9999999999999999999999999999999999999a" }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE when the RPC client throws unexpectedly", async () => {
    const throwingRpc: ChainRpcClient = {
      ...buildFakeRpc(),
      async getTransactionReceipt() {
        throw new Error("network blip");
      },
    };
    const result = await verifySettlementTransaction(baseParams({ rpc: throwingRpc }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RPC_TEMPORARILY_UNAVAILABLE");
  });
});
