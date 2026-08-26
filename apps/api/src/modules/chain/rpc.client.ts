import {
  BlockNotFoundError,
  createPublicClient,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import type { RawEventLog } from "./task-funded-event.js";
import { TASK_ESCROW_STAKE_RATE_BPS_ABI } from "./task-escrow-accept-abi.js";

/**
 * Minimal, backend-only read shape of a transaction receipt. Deliberately
 * NOT viem's own `TransactionReceipt` type — that type carries dozens of
 * fields (`cumulativeGasUsed`, `effectiveGasPrice`, `type`, ...) this
 * module has no use for, and re-exporting it would make `tx-verifier.ts`
 * depend on viem's concrete types closely enough that a unit test could
 * only construct one by importing viem itself. This narrower shape is what
 * both the real client below and a unit test's fake client need to agree
 * on.
 */
export interface TransactionReceiptResult {
  status: "success" | "reverted";
  to: string | null;
  blockNumber: bigint;
  blockHash: string;
  logs: RawEventLog[];
}

export interface BlockResult {
  hash: string;
  number: bigint;
}

/**
 * Minimal, backend-only read shape of a transaction itself (NOT its
 * receipt) — only the field `acceptance-tx-verifier.ts` actually needs
 * (T-806): the raw calldata (`input`), which is the ONLY place
 * `AcceptancePermit.nonce` is recoverable from. `TaskAccepted` (the event
 * log, read via `getTransactionReceipt` above) carries no `nonce` at all —
 * receipts alone can never disambiguate which of several outstanding
 * permits for the same wallet was actually used, only the transaction's own
 * calldata can. Same "minimal necessary fields, not viem's full
 * `Transaction` type" discipline as `TransactionReceiptResult` above.
 */
export interface TransactionResult {
  input: `0x${string}`;
}

/**
 * The independent, read-only RPC client `tx-verifier.ts`/`event-sync.ts`
 * verify funding transactions through. This interface — not viem's
 * `PublicClient` — is what those modules depend on, so their unit tests
 * can supply a plain object fake instead of standing up a real (or even
 * mocked) JSON-RPC endpoint.
 *
 * "独立" (PRD §8.2 步骤 7 / this Feature's design.md "安全/兼容性"): the
 * concrete implementation below reads its endpoint from a dedicated
 * `BACKEND_RPC_URL` env var, wired independently of whatever RPC provider
 * the frontend wallet uses (`apps/web`'s `VITE_WALLET_RPC_URL`) — a
 * front-end-controlled or compromised wallet provider can never influence
 * what this client sees.
 */
export interface ChainRpcClient {
  /** `null` means "no receipt for this hash" (routine — an unmined or
   * unknown tx). A thrown error means the RPC call itself failed (network,
   * timeout, node error) and must be treated as "unknown", never as "not
   * found" — the whole point of the TRANSACTION_NOT_FOUND vs
   * RPC_TEMPORARILY_UNAVAILABLE distinction (F-606). */
  getTransactionReceipt(txHash: `0x${string}`): Promise<TransactionReceiptResult | null>;
  getBlockNumber(): Promise<bigint>;
  /** `null` means the requested block number does not currently resolve on
   * the connected node (e.g. it was reorged out, or the node hasn't seen
   * it) — used both by tx-verifier's confirmation check and event-sync's
   * reorg detection. */
  getBlock(params: { blockNumber: bigint }): Promise<BlockResult | null>;
  getChainId(): Promise<number>;
  /** `null` means "no such transaction" (routine — same meaning as
   * `getTransactionReceipt`'s `null`). A thrown error means the RPC call
   * itself failed and must be treated as unknown, same discipline as every
   * other method on this interface (T-806). */
  getTransaction(txHash: `0x${string}`): Promise<TransactionResult | null>;
  /** Reads `TaskEscrow.STAKE_RATE_BPS` directly from the deployed contract
   * (T-806, independent stake verification — user's item #6) —
   * `contractAddress` is passed explicitly (not read from env inside this
   * client) so this stays symmetric with how every other trusted-contract
   * value flows in from the caller (`trustedContractAddress` params
   * elsewhere in this module), never resolved twice from two different
   * sources. */
  readStakeRateBps(contractAddress: `0x${string}`): Promise<bigint>;
  /**
   * Reads `TaskEscrow.authorizedSigner()` — a `public immutable address` set
   * once at contract deployment and never changed afterwards (Feature 7
   * sync, T-709). Used by `permit.service.ts`'s `verifySignerMatchesContract`
   * to confirm the locally configured `ACCEPTANCE_PERMIT_SIGNER_KEY`
   * actually matches the signer address the deployed contract will accept —
   * a mismatch means every `AcceptancePermit` this service issues would be
   * rejected on-chain by `acceptTask` with `InvalidPermitSignature`.
   */
  readAuthorizedSigner(contractAddress: `0x${string}`): Promise<`0x${string}`>;
}

/**
 * Minimal ABI fragment — only the one read-only view function
 * `readAuthorizedSigner` needs (Feature 7 sync, T-709), same "smallest
 * necessary shape" convention as `TASK_ESCROW_STAKE_RATE_BPS_ABI`.
 */
const AUTHORIZED_SIGNER_ABI = [
  {
    type: "function",
    name: "authorizedSigner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const BACKEND_RPC_URL_VAR = "BACKEND_RPC_URL";

function resolveRpcUrl(env: NodeJS.ProcessEnv): string {
  const url = env[BACKEND_RPC_URL_VAR];
  if (!url) {
    throw new Error(
      `${BACKEND_RPC_URL_VAR} is not set. This must be a dedicated backend-only RPC endpoint, ` +
        "isolated from any frontend wallet provider (PRD §8.2 步骤 7 独立 RPC; see .env.example's " +
        `${BACKEND_RPC_URL_VAR}) — do not point this at the same value apps/web uses for wallet ` +
        "connections.",
    );
  }
  return url;
}

/**
 * Constructs the real `ChainRpcClient`, backed by viem's `createPublicClient`
 * over HTTP. Reads `BACKEND_RPC_URL` at call time (not import time), so
 * importing this module has no side effect and tests never need a real env
 * var set just to import the type.
 */
export function createChainRpcClient(env: NodeJS.ProcessEnv = process.env): ChainRpcClient {
  const client = createPublicClient({ transport: http(resolveRpcUrl(env)) });

  return {
    async getTransactionReceipt(txHash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        return {
          status: receipt.status,
          to: receipt.to,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
            logIndex: log.logIndex ?? 0,
          })),
        };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) {
          return null;
        }
        throw error;
      }
    },
    getBlockNumber() {
      return client.getBlockNumber();
    },
    async getBlock({ blockNumber }) {
      try {
        const block = await client.getBlock({ blockNumber });
        return { hash: block.hash, number: block.number };
      } catch (error) {
        if (error instanceof BlockNotFoundError) {
          return null;
        }
        // Any other error (network, timeout, node error) is a genuine RPC
        // failure, not "this block doesn't exist" — rethrow so callers
        // treat it as RPC_TEMPORARILY_UNAVAILABLE, the same distinction
        // getTransactionReceipt draws above.
        throw error;
      }
    },
    getChainId() {
      return client.getChainId();
    },
    async getTransaction(txHash) {
      try {
        const tx = await client.getTransaction({ hash: txHash });
        return { input: tx.input };
      } catch (error) {
        if (error instanceof TransactionNotFoundError) {
          return null;
        }
        throw error;
      }
    },
    async readStakeRateBps(contractAddress) {
      return client.readContract({
        address: contractAddress,
        abi: TASK_ESCROW_STAKE_RATE_BPS_ABI,
        functionName: "STAKE_RATE_BPS",
      });
    },
    readAuthorizedSigner(contractAddress) {
      return client.readContract({
        address: contractAddress,
        abi: AUTHORIZED_SIGNER_ABI,
        functionName: "authorizedSigner",
      });
    },
  };
}
