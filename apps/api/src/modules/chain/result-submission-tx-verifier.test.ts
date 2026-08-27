import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "./rpc.client.js";
import { RESULT_SUBMITTED_EVENT_ABI } from "./result-submitted-event.js";
import type { RawEventLog } from "./task-funded-event.js";
import {
  verifyResultSubmissionTransaction,
  type ResultSubmissionVerificationExpectation,
  type VerifyResultSubmissionTransactionParams,
} from "./result-submission-tx-verifier.js";

const TX_HASH = ("0x" + "a".repeat(64)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a" as `0x${string}`;
const AGENT_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" as `0x${string}`;
const TASK_ID_ON_CHAIN = ("0x" + "1".repeat(64)) as `0x${string}`;
const RESULT_HASH = ("0x" + "c".repeat(64)) as `0x${string}`;
const SUBMITTED_AT = 1_800_000_000n;
const REVIEW_DEADLINE = SUBMITTED_AT + 259_200n;
const EXPECTED_CHAIN_ID = 31337;
const RECEIPT_BLOCK_NUMBER = 100n;
const REQUIRED_CONFIRMATIONS = 3;

function buildResultSubmittedLog(
  overrides: {
    taskId?: `0x${string}`;
    agent?: `0x${string}`;
    resultHash?: `0x${string}`;
    submittedAt?: bigint;
    reviewDeadline?: bigint;
  } = {},
): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const agent = overrides.agent ?? AGENT_ADDRESS;
  const resultHash = overrides.resultHash ?? RESULT_HASH;
  const submittedAt = overrides.submittedAt ?? SUBMITTED_AT;
  const reviewDeadline = overrides.reviewDeadline ?? REVIEW_DEADLINE;

  const topics = encodeEventTopics({
    abi: RESULT_SUBMITTED_EVENT_ABI,
    eventName: "ResultSubmitted",
    args: { taskId, agent: getAddress(agent) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "resultHash", type: "bytes32" },
      { name: "submittedAt", type: "uint64" },
      { name: "reviewDeadline", type: "uint64" },
    ],
    [resultHash, submittedAt, reviewDeadline],
  );

  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildReceipt(overrides: Partial<TransactionReceiptResult> = {}): TransactionReceiptResult {
  return {
    status: "success",
    to: TRUSTED_CONTRACT,
    blockNumber: RECEIPT_BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    logs: [buildResultSubmittedLog()],
    ...overrides,
  };
}

const VALID_EXPECTATION: ResultSubmissionVerificationExpectation = {
  taskIdOnChain: TASK_ID_ON_CHAIN,
  agentAddress: AGENT_ADDRESS,
};

/** Confirmations = currentBlockNumber - receipt.blockNumber + 1, so this
 * places the tx exactly at REQUIRED_CONFIRMATIONS. */
const CONFIRMED_CURRENT_BLOCK_NUMBER = RECEIPT_BLOCK_NUMBER + BigInt(REQUIRED_CONFIRMATIONS) - 1n;

interface FakeRpcOptions {
  receipt?: TransactionReceiptResult | null | (() => Promise<TransactionReceiptResult | null>);
  chainId?: number;
  currentBlockNumber?: bigint;
  canonicalBlock?: BlockResult | null;
  getTransactionReceiptError?: Error;
  getBlockError?: Error;
  getBlockNumberError?: Error;
}

function buildFakeRpc(options: FakeRpcOptions = {}): ChainRpcClient {
  const {
    receipt = buildReceipt(),
    chainId = EXPECTED_CHAIN_ID,
    currentBlockNumber = CONFIRMED_CURRENT_BLOCK_NUMBER,
    canonicalBlock = { hash: BLOCK_HASH, number: RECEIPT_BLOCK_NUMBER },
    getTransactionReceiptError,
    getBlockError,
    getBlockNumberError,
  } = options;

  return {
    async getTransactionReceipt() {
      if (getTransactionReceiptError) {
        throw getTransactionReceiptError;
      }
      if (typeof receipt === "function") {
        return receipt();
      }
      return receipt;
    },
    async getBlockNumber() {
      if (getBlockNumberError) {
        throw getBlockNumberError;
      }
      return currentBlockNumber;
    },
    async getBlock() {
      if (getBlockError) {
        throw getBlockError;
      }
      return canonicalBlock;
    },
    async getChainId() {
      return chainId;
    },
    // Unused by result-submission-tx-verifier.ts — no stake/nonce
    // cross-check for ResultSubmitted (see this module's own header
    // comment on why: submitResult already enforces task.agent ==
    // msg.sender on-chain).
    async getTransaction() {
      throw new Error("getTransaction: not used by result-submission-tx-verifier");
    },
    async readStakeRateBps() {
      throw new Error("readStakeRateBps: not used by result-submission-tx-verifier");
    },
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by result-submission-tx-verifier");
    },
    async readHasRole() {
      throw new Error("readHasRole: not used by result-submission-tx-verifier");
    },
  };
}

function buildParams(
  overrides: Partial<VerifyResultSubmissionTransactionParams> = {},
): VerifyResultSubmissionTransactionParams {
  return {
    rpc: buildFakeRpc(),
    txHash: TX_HASH,
    expectedChainId: EXPECTED_CHAIN_ID,
    trustedContractAddress: TRUSTED_CONTRACT,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    expected: VALID_EXPECTATION,
    ...overrides,
  };
}

describe("verifyResultSubmissionTransaction", () => {
  it("returns ok:true with the decoded event and correct confirmations when every check passes", async () => {
    const result = await verifyResultSubmissionTransaction(buildParams());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.confirmations).toBe(REQUIRED_CONFIRMATIONS);
    expect(result.blockHash).toBe(BLOCK_HASH);
    expect(result.event.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(result.event.agent.toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    expect(result.event.resultHash.toLowerCase()).toBe(RESULT_HASH.toLowerCase());
    expect(result.event.submittedAt).toBe(SUBMITTED_AT);
    expect(result.event.reviewDeadline).toBe(REVIEW_DEADLINE);
  });

  it("returns TRANSACTION_NOT_FOUND when the receipt resolves to null (routine: unmined/unknown tx)", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: null }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("TRANSACTION_NOT_FOUND");
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE (not TRANSACTION_NOT_FOUND) when getTransactionReceipt throws", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({
        rpc: buildFakeRpc({ getTransactionReceiptError: new Error("connection reset") }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("RPC_TEMPORARILY_UNAVAILABLE");
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE when getBlockNumber throws mid-verification", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({ rpc: buildFakeRpc({ getBlockNumberError: new Error("timeout") }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("RPC_TEMPORARILY_UNAVAILABLE");
  });

  it("returns CHAIN_UNSUPPORTED when the RPC's chainId doesn't match the configured chain", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({ rpc: buildFakeRpc({ chainId: 999 }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("CHAIN_UNSUPPORTED");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when receipt.status is reverted", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ status: "reverted" }) }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when confirmations fall short of required", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({
        rpc: buildFakeRpc({ currentBlockNumber: RECEIPT_BLOCK_NUMBER }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the canonical block hash no longer matches the receipt (reorg)", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({
        rpc: buildFakeRpc({
          canonicalBlock: {
            hash: ("0x" + "9".repeat(64)) as `0x${string}`,
            number: RECEIPT_BLOCK_NUMBER,
          },
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the canonical block no longer resolves at all", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({ rpc: buildFakeRpc({ canonicalBlock: null }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("TRANSACTION_NOT_CONFIRMED");
  });

  it("returns FUNDING_EVENT_MISMATCH when receipt.to is not the trusted contract address", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ to: "0x9876543210987654321098765432109876543210" }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns FUNDING_EVENT_MISMATCH when receipt.to is null", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ to: null }) }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns FUNDING_EVENT_MISMATCH when no ResultSubmitted log can be decoded from the receipt", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ logs: [] }) }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded taskId doesn't match expected", async () => {
    const result = await verifyResultSubmissionTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({
            logs: [buildResultSubmittedLog({ taskId: ("0x" + "2".repeat(64)) as `0x${string}` })],
          }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded agent doesn't match the expected session address", async () => {
    const otherAgent = "0x9876543210987654321098765432109876543210" as `0x${string}`;
    const result = await verifyResultSubmissionTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildResultSubmittedLog({ agent: otherAgent })] }),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });
});
