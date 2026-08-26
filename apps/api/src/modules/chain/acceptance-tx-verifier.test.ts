import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress } from "viem";
import type {
  BlockResult,
  ChainRpcClient,
  TransactionReceiptResult,
  TransactionResult,
} from "./rpc.client.js";
import { TASK_ACCEPTED_EVENT_ABI } from "./task-accepted-event.js";
import type { RawEventLog } from "./task-funded-event.js";
import { TASK_ESCROW_ACCEPT_TASK_ABI } from "./task-escrow-accept-abi.js";
import {
  decodeAcceptTaskCalldata,
  verifyAcceptanceTransaction,
  type AcceptanceVerificationExpectation,
  type VerifyAcceptanceTransactionParams,
} from "./acceptance-tx-verifier.js";

const TX_HASH = ("0x" + "a".repeat(64)) as `0x${string}`;
const BLOCK_HASH = ("0x" + "b".repeat(64)) as `0x${string}`;
const TRUSTED_CONTRACT = "0x111111111111111111111111111111111111111a" as `0x${string}`;
const AGENT_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" as `0x${string}`;
const TASK_ID_ON_CHAIN = ("0x" + "1".repeat(64)) as `0x${string}`;
const EXPECTED_CHAIN_ID = 31337;
const RECEIPT_BLOCK_NUMBER = 100n;
const REQUIRED_CONFIRMATIONS = 3;

// Stake deliberately exceeds Number.MAX_SAFE_INTEGER to match tx-verifier's
// discipline of proving BigInt-precise handling isn't silently lossy. As of
// T-806, `stake` IS independently cross-checked (against
// `budget * STAKE_RATE_BPS / 10000`) — BUDGET and DEFAULT_STAKE_RATE_BPS
// below are chosen so that relationship holds exactly (`budget === STAKE`
// at a 100% rate), keeping this constant's original "large uint256, not a
// hardcoded round number" character while still passing the new check.
const STAKE = 12_345_678_901_234_567_890n;
const BUDGET = STAKE.toString();
const DEFAULT_STAKE_RATE_BPS = 10_000n; // 100% — see BUDGET's comment above.
const NONCE = 999_888_777_666_555n;

/** Real `acceptTask` calldata, built with the same ABI
 * `decodeAcceptTaskCalldata` decodes — proves the nonce-decoding path
 * against actual viem encoding, not a hand-rolled byte string. */
function buildAcceptTaskCalldata(
  overrides: { nonce?: bigint; agent?: `0x${string}`; taskId?: `0x${string}` } = {},
): `0x${string}` {
  return encodeFunctionData({
    abi: TASK_ESCROW_ACCEPT_TASK_ABI,
    functionName: "acceptTask",
    args: [
      {
        taskId: overrides.taskId ?? TASK_ID_ON_CHAIN,
        agent: getAddress(overrides.agent ?? AGENT_ADDRESS),
        nonce: overrides.nonce ?? NONCE,
        expiry: 9_999_999_999n,
        chainId: BigInt(EXPECTED_CHAIN_ID),
        verifyingContract: getAddress(TRUSTED_CONTRACT),
      },
      ("0x" + "cd".repeat(65)) as `0x${string}`,
    ],
  });
}

function buildTaskAcceptedLog(
  overrides: { taskId?: `0x${string}`; agent?: `0x${string}`; stake?: bigint } = {},
): RawEventLog {
  const taskId = overrides.taskId ?? TASK_ID_ON_CHAIN;
  const agent = overrides.agent ?? AGENT_ADDRESS;
  const stake = overrides.stake ?? STAKE;

  const topics = encodeEventTopics({
    abi: TASK_ACCEPTED_EVENT_ABI,
    eventName: "TaskAccepted",
    args: { taskId, agent: getAddress(agent) },
  }) as readonly string[];
  const data = encodeAbiParameters([{ name: "stake", type: "uint256" }], [stake]);

  return { address: TRUSTED_CONTRACT, topics, data, logIndex: 0 };
}

function buildReceipt(overrides: Partial<TransactionReceiptResult> = {}): TransactionReceiptResult {
  return {
    status: "success",
    to: TRUSTED_CONTRACT,
    blockNumber: RECEIPT_BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    logs: [buildTaskAcceptedLog()],
    ...overrides,
  };
}

const VALID_EXPECTATION: AcceptanceVerificationExpectation = {
  taskIdOnChain: TASK_ID_ON_CHAIN,
  agentAddress: AGENT_ADDRESS,
  budget: BUDGET,
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
  /** T-806: defaults to real `acceptTask` calldata carrying `NONCE` — see
   * `buildAcceptTaskCalldata`. `null` simulates "no such transaction
   * found"; a raw `0x`-string simulates calldata that doesn't decode as
   * `acceptTask` at all. */
  transaction?: TransactionResult | null;
  /** T-806: defaults to `DEFAULT_STAKE_RATE_BPS`, chosen so `STAKE` above
   * matches `BUDGET * rate / 10000` exactly (see `STAKE`'s own comment). */
  stakeRateBps?: bigint;
  getTransactionError?: Error;
  readStakeRateBpsError?: Error;
}

function buildFakeRpc(options: FakeRpcOptions = {}): ChainRpcClient {
  const {
    receipt = buildReceipt(),
    chainId = EXPECTED_CHAIN_ID,
    currentBlockNumber = CONFIRMED_CURRENT_BLOCK_NUMBER,
    canonicalBlock = { hash: BLOCK_HASH, number: RECEIPT_BLOCK_NUMBER },
    getTransactionReceiptError,
    getBlockError,
    transaction = { input: buildAcceptTaskCalldata() },
    stakeRateBps = DEFAULT_STAKE_RATE_BPS,
    getTransactionError,
    readStakeRateBpsError,
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
    async getTransaction() {
      if (getTransactionError) {
        throw getTransactionError;
      }
      return transaction;
    },
    async readStakeRateBps() {
      if (readStakeRateBpsError) {
        throw readStakeRateBpsError;
      }
      return stakeRateBps;
    },
    // Feature 7 sync (T-709): unused by acceptance-tx-verifier.ts — its sole
    // caller is verifySignerMatchesContract (permit.service.ts).
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by acceptance-tx-verifier");
    },
  };
}

function buildParams(
  overrides: Partial<VerifyAcceptanceTransactionParams> = {},
): VerifyAcceptanceTransactionParams {
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

describe("verifyAcceptanceTransaction", () => {
  it("returns ok:true with the decoded event and correct confirmations when every check passes", async () => {
    const result = await verifyAcceptanceTransaction(buildParams());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.confirmations).toBe(REQUIRED_CONFIRMATIONS);
    expect(result.blockHash).toBe(BLOCK_HASH);
    expect(result.event.taskId.toLowerCase()).toBe(TASK_ID_ON_CHAIN.toLowerCase());
    expect(result.event.agent.toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    expect(result.event.stake).toBe(STAKE);
    // T-806: the nonce comes from decoding the TRANSACTION's own calldata
    // (`rpc.getTransaction` + `decodeAcceptTaskCalldata`), never from the
    // event log — this is the whole point of item #2 (precise attribution).
    expect(result.event.nonce).toBe(NONCE);
  });

  // T-806, user's item #6: independent stake verification — `stake` must
  // equal `budget * STAKE_RATE_BPS / 10000` as this backend independently
  // computes it, not merely whatever the event happens to say.
  it("returns FUNDING_EVENT_MISMATCH when the decoded stake does not match budget * STAKE_RATE_BPS / 10000", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({
        // A realistic 6% rate (matching contracts/src/TaskEscrow.sol's
        // actual STAKE_RATE_BPS = 600) against BUDGET, which was chosen to
        // match STAKE only at a 100% rate — at 600 bps the expected stake
        // is far smaller than the event's actual STAKE, a genuine mismatch.
        rpc: buildFakeRpc({ stakeRateBps: 600n }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
    if (result.ok) throw new Error("expected ok:false");
    expect(result.message).toContain("stake");
  });

  it("returns ok:true when the stake matches an independently computed rate/budget exactly", async () => {
    // budget=200, rate=600bps -> expectedStake = 200*600/10000 = 12.
    const result = await verifyAcceptanceTransaction(
      buildParams({
        expected: { ...VALID_EXPECTATION, budget: "200" },
        rpc: buildFakeRpc({
          stakeRateBps: 600n,
          receipt: buildReceipt({ logs: [buildTaskAcceptedLog({ stake: 12n })] }),
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  // T-806, user's items #1/#2: the transaction's own calldata is the ONLY
  // source of the nonce — these prove that path is actually exercised and
  // fails safely when it can't be.
  it("returns FUNDING_EVENT_MISMATCH when rpc.getTransaction resolves to null (no such transaction)", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({ rpc: buildFakeRpc({ transaction: null }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when the transaction's calldata does not decode as acceptTask", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({
        rpc: buildFakeRpc({ transaction: { input: "0xdeadbeef" } }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE when rpc.getTransaction throws", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({
        rpc: buildFakeRpc({ getTransactionError: new Error("ECONNRESET") }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "RPC_TEMPORARILY_UNAVAILABLE" });
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE when rpc.readStakeRateBps throws", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({
        rpc: buildFakeRpc({ readStakeRateBpsError: new Error("timeout") }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "RPC_TEMPORARILY_UNAVAILABLE" });
  });

  it("returns TRANSACTION_NOT_FOUND when the receipt resolves to null (routine: unmined/unknown tx)", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: null }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_FOUND" });
  });

  it("returns RPC_TEMPORARILY_UNAVAILABLE (not TRANSACTION_NOT_FOUND) when getTransactionReceipt throws", async () => {
    const result = await verifyAcceptanceTransaction(
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
    const result = await verifyAcceptanceTransaction(buildParams({ rpc: failingRpc }));
    expect(result).toMatchObject({ ok: false, code: "RPC_TEMPORARILY_UNAVAILABLE" });
  });

  it("returns CHAIN_UNSUPPORTED when the RPC's chainId doesn't match the configured chain", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({ rpc: buildFakeRpc({ chainId: 1 }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "CHAIN_UNSUPPORTED" });
  });

  it("returns TRANSACTION_NOT_CONFIRMED when receipt.status is reverted", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ status: "reverted" }) }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_CONFIRMED" });
  });

  it("returns TRANSACTION_NOT_CONFIRMED when confirmations fall short of required", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({
        rpc: buildFakeRpc({ currentBlockNumber: RECEIPT_BLOCK_NUMBER }), // only 1 confirmation
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_CONFIRMED" });
  });

  it("returns TRANSACTION_NOT_CONFIRMED when the canonical block hash no longer matches the receipt (reorg)", async () => {
    const result = await verifyAcceptanceTransaction(
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
    const result = await verifyAcceptanceTransaction(
      buildParams({ rpc: buildFakeRpc({ canonicalBlock: null }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "TRANSACTION_NOT_CONFIRMED" });
  });

  it("returns FUNDING_EVENT_MISMATCH when receipt.to is not the trusted contract address", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ to: "0x000000000000000000000000000000000000dead" }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when receipt.to is null", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ to: null }) }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when no TaskAccepted log can be decoded from the receipt", async () => {
    const result = await verifyAcceptanceTransaction(
      buildParams({ rpc: buildFakeRpc({ receipt: buildReceipt({ logs: [] }) }) }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded taskId doesn't match expected", async () => {
    const wrongTaskId = ("0x" + "2".repeat(64)) as `0x${string}`;
    const result = await verifyAcceptanceTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildTaskAcceptedLog({ taskId: wrongTaskId })] }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });

  it("returns FUNDING_EVENT_MISMATCH when the decoded agent doesn't match the expected session address", async () => {
    const wrongAgent = "0x999999999999999999999999999999999999999b" as `0x${string}`;
    const result = await verifyAcceptanceTransaction(
      buildParams({
        rpc: buildFakeRpc({
          receipt: buildReceipt({ logs: [buildTaskAcceptedLog({ agent: wrongAgent })] }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "FUNDING_EVENT_MISMATCH" });
  });
});

describe("decodeAcceptTaskCalldata", () => {
  it("decodes the nonce from real acceptTask calldata", () => {
    const calldata = buildAcceptTaskCalldata({ nonce: 42n });
    const decoded = decodeAcceptTaskCalldata(calldata);
    expect(decoded).toEqual({ nonce: 42n });
  });

  it("returns null (does not throw) for calldata that isn't an acceptTask call", () => {
    expect(decodeAcceptTaskCalldata("0xdeadbeef")).toBeNull();
  });

  it("returns null for empty calldata", () => {
    expect(decodeAcceptTaskCalldata("0x")).toBeNull();
  });
});
