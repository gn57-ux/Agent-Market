import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from "viem";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "./rpc.client.js";
import { TASK_FUNDED_EVENT_ABI, type RawEventLog } from "./task-funded-event.js";
import {
  verifyFundingTransaction,
  type FundingVerificationExpectation,
  type VerifyFundingTransactionParams,
} from "./tx-verifier.js";

const TX_HASH = ("0x" + "a".repeat(64)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a" as `0x${string}`;
const REQUESTER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" as `0x${string}`;
const TOKEN_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4" as `0x${string}`;
const TASK_ID_ON_CHAIN = keccak256(toHex("task-1")) as `0x${string}`;
const EXPECTED_CHAIN_ID = 31337;
const RECEIPT_BLOCK_NUMBER = 100n;
const REQUIRED_CONFIRMATIONS = 3;

// Budget deliberately exceeds Number.MAX_SAFE_INTEGER (2^53 - 1) to prove the
// comparison in tx-verifier.ts is a real BigInt comparison, not a
// Number()-converted one that would silently lose precision and could
// coincidentally still compare equal.
const BUDGET = 12_345_678_901_234_567_890n;
const DELIVERY_DEADLINE_DATE = new Date("2030-06-15T12:00:00Z");
const DELIVERY_DEADLINE_UNIX_SECONDS = BigInt(Math.floor(DELIVERY_DEADLINE_DATE.getTime() / 1000));

function buildTaskFundedLog(
  overrides: {
    taskId?: `0x${string}`;
    requester?: `0x${string}`;
    token?: `0x${string}`;
    budget?: bigint;
    deliveryDeadline?: bigint;
  } = {},
): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const requester = overrides.requester ?? REQUESTER_ADDRESS;
  const token = overrides.token ?? TOKEN_ADDRESS;
  const budget = overrides.budget ?? BUDGET;
  const deliveryDeadline = overrides.deliveryDeadline ?? DELIVERY_DEADLINE_UNIX_SECONDS;

  const topics = encodeEventTopics({
    abi: TASK_FUNDED_EVENT_ABI,
    eventName: "TaskFunded",
    args: { taskId, requester: getAddress(requester) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "deliveryDeadline", type: "uint64" },
    ],
    [getAddress(token), budget, deliveryDeadline],
  );

  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildReceipt(overrides: Partial<TransactionReceiptResult> = {}): TransactionReceiptResult {
  return {
    status: "success",
    to: TRUSTED_CONTRACT,
    blockNumber: RECEIPT_BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    logs: [buildTaskFundedLog()],
    ...overrides,
  };
}

const VALID_EXPECTATION: FundingVerificationExpectation = {
  taskIdOnChain: TASK_ID_ON_CHAIN,
  requesterAddress: REQUESTER_ADDRESS,
  token: TOKEN_ADDRESS,
  budget: BUDGET.toString(),
  deliveryDeadline: DELIVERY_DEADLINE_DATE,
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
}

function buildFakeRpc(options: FakeRpcOptions = {}): ChainRpcClient {
  const {
    receipt = buildReceipt(),
    chainId = EXPECTED_CHAIN_ID,
    currentBlockNumber = CONFIRMED_CURRENT_BLOCK_NUMBER,
    canonicalBlock = { hash: BLOCK_HASH, number: RECEIPT_BLOCK_NUMBER },
    getTransactionReceiptError,
    getBlockError,
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
    // T-806: `ChainRpcClient` gained `getTransaction`/`readStakeRateBps` for
    // acceptance-tx-verifier.ts's independent nonce-decoding/stake checks —
    // funding verification never calls either, so these are unused stubs
    // this suite never has a reason to exercise.
    async getTransaction() {
      throw new Error("getTransaction: not used by funding verification");
    },
    async readStakeRateBps() {
      throw new Error("readStakeRateBps: not used by funding verification");
    },
    // Feature 7 sync (T-709): unused by funding verification — see above.
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by funding verification");
    },
  };
}

function buildParams(
  overrides: Partial<VerifyFundingTransactionParams> = {},
): VerifyFundingTransactionParams {
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

describe("verifyFundingTransaction", () => {
  it("returns ok:true with the decoded event and correct confirmations when every check passes", async () => {
    const result = await verifyFundingTransaction(buildParams());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.confirmations).toBe(REQUIRED_CONFIRMATIONS);
    expect(result.blockHash).toBe(BLOCK_HASH);
    expect(result.event.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(result.event.requester.toLowerCase()).toBe(REQUESTER_ADDRESS.toLowerCase());
    expect(result.event.token.toLowerCase()).toBe(TOKEN_ADDRESS.toLowerCase());
    expect(result.event.budget).toBe(BUDGET);
    expect(result.event.deliveryDeadline).toBe(DELIVERY_DEADLINE_UNIX_SECONDS);
  });

  it("returns TRANSACTION_NOT_FOUND when the receipt resolves to null (routine: unmined/unknown tx)", async () => {
    const result = await verifyFundingTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: null }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_FOUND" });
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE (not TRANSACTION_NOT_FOUND) when getTransactionReceipt throws", async () => {
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({ getTransactionReceiptError: new Error("ECONNRESET") }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "RPC_TEMPORARILY_UNAVAILABLE" });
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).not.toBe("TRANSACTION_NOT_FOUND");
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE when getBlockNumber throws mid-verification", async () => {
    const rpc = buildFakeRpc();
    const failingRpc: ChainRpcClient = {
      ...rpc,
      async getBlockNumber() {
        throw new Error("timeout");
      },
    };
    const result = await verifyFundingTransaction(buildParams({ rpc: failingRpc }));
    expect(result).toMatchObject({ ok: false, code: "RPC_TEMPORARILY_UNAVAILABLE" });
  });

  it("returns CHAIN_UNSUPPORTED when the RPC's chainId doesn't match the configured chain", async () => {
    const result = await verifyFundingTransaction(
      buildParams({ rpc: buildFakeRpc({ chainId: 1 }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "CHAIN_UNSUPPORTED" });
  });

  it("returns TRANSACTION_NOT_CONFIRMED when receipt.status is reverted", async () => {
    const result = await verifyFundingTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ status: "reverted" }) }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_CONFIRMED" });
  });

  it("returns TRANSACTION_NOT_CONFIRMED when confirmations fall short of required", async () => {
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({ currentBlockNumber: RECEIPT_BLOCK_NUMBER }), // only 1 confirmation
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_CONFIRMED" });
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the canonical block hash no longer matches the receipt (reorg)", async () => {
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({
          canonicalBlock: {
            hash: ("0x" + "c".repeat(64)) as `0x${string}`,
            number: RECEIPT_BLOCK_NUMBER,
          },
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_CONFIRMED" });
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the canonical block no longer resolves at all", async () => {
    const result = await verifyFundingTransaction(
      buildParams({ rpc: buildFakeRpc({ canonicalBlock: null }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_CONFIRMED" });
  });

  it("returns FUNDING_EVENT_MISMATCH when receipt.to is not the trusted contract address", async () => {
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ to: "0x000000000000000000000000000000000000dead" }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when receipt.to is null", async () => {
    const result = await verifyFundingTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ to: null }) }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when no TaskFunded log can be decoded from the receipt", async () => {
    const result = await verifyFundingTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ logs: [] }) }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded taskId doesn't match the draft", async () => {
    const wrongTaskId = keccak256(toHex("some-other-task"));
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildTaskFundedLog({ taskId: wrongTaskId })] }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded requester doesn't match the draft", async () => {
    const wrongRequester = "0x999999999999999999999999999999999999999b" as `0x${string}`;
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildTaskFundedLog({ requester: wrongRequester })] }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded token doesn't match the draft", async () => {
    const mismatchedTokenAddr = "0x888888888888888888888888888888888888888c" as `0x${string}`;
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildTaskFundedLog({ token: mismatchedTokenAddr })] }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH on a budget mismatch, proving BigInt-precise comparison beyond MAX_SAFE_INTEGER", async () => {
    // Off by exactly 1 unit at a magnitude far beyond Number.MAX_SAFE_INTEGER
    // (2^53 - 1 ≈ 9.007e15). If the comparison secretly went through
    // Number(), these two values could collapse to the same float and this
    // mismatch would be missed.
    const almostSameBudget = BUDGET + 1n;
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildTaskFundedLog({ budget: almostSameBudget })] }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("treats a budget beyond Number.MAX_SAFE_INTEGER as an exact match when it truly matches", async () => {
    expect(BUDGET).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const result = await verifyFundingTransaction(buildParams());
    expect(result.ok).toBe(true);
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded deliveryDeadline doesn't match the draft", async () => {
    const wrongDeadline = DELIVERY_DEADLINE_UNIX_SECONDS + 3600n;
    const result = await verifyFundingTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({
            logs: [buildTaskFundedLog({ deliveryDeadline: wrongDeadline })],
          }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });
});
