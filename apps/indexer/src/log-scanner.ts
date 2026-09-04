import { BlockNotFoundError, createPublicClient, http } from "viem";
import type { RawEventLog } from "@agent-market/domain";

/**
 * One raw log plus the block/tx identity `chain_indexed_events` needs to
 * persist it (`decodeAnyEvent` only needs `RawEventLog`'s four fields; this
 * widens that with exactly what the repository's `UNIQUE (chain_id,
 * tx_hash, log_index)` and `block_number`/`block_hash` columns need —
 * same "widen only for what the caller actually persists" discipline
 * `result-submitted-log-scanner.ts`'s own `ResultSubmittedLogEntry`
 * documents for its own narrower purpose).
 */
export interface ScannedLog extends RawEventLog {
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
}

/**
 * Read-only chain access this indexer needs: the current block height (to
 * know how far it's allowed to scan) and every log the `TaskEscrow`
 * contract emitted in a block range — deliberately NOT filtered to one
 * event type (unlike `result-submitted-log-scanner.ts`'s single-purpose
 * scanner), since F-1807 requires scanning every event type the contract
 * emits, and `decodeAnyEvent` (not this client) is where "which event type
 * is this" gets decided.
 */
export interface ChainLogScanner {
  getLatestBlockNumber(): Promise<bigint>;
  scanLogs(params: {
    contractAddress: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ScannedLog[]>;
  /**
   * F-1808 (T-1807): the chain's CURRENT canonical block hash at a given
   * height — the reorg-detection primitive. A stored `PENDING_CONFIRMATION`
   * row's own `block_hash` (recorded when it was first scanned) is compared
   * against this; a mismatch means that height's block has been replaced by
   * a reorg. Returns `null` if the chain no longer has ANY block at that
   * height (a reorg that shortened the chain below it) rather than
   * throwing — a real, expected outcome for the caller to treat exactly
   * like a hash mismatch (both mean "the previously-scanned block there is
   * gone").
   */
  getBlockHash(blockNumber: bigint): Promise<string | null>;
}

const BACKEND_RPC_URL_VAR = "BACKEND_RPC_URL";

function resolveRpcUrl(env: NodeJS.ProcessEnv): string {
  const url = env[BACKEND_RPC_URL_VAR];
  if (!url) {
    throw new Error(
      `${BACKEND_RPC_URL_VAR} is not set. Same dedicated backend-only RPC endpoint apps/api's ` +
        "rpc.client.ts reads — see that module's doc comment for why it must stay isolated from " +
        "any frontend wallet provider.",
    );
  }
  return url;
}

/**
 * Real, viem-backed `ChainLogScanner` — own `createPublicClient`, own env
 * read (not shared with apps/api's `rpc.client.ts`, which this app cannot
 * import — see `db.ts`'s note on why `apps/api` isn't importable as a
 * library). Reads `BACKEND_RPC_URL` at call time, not import time, so
 * importing this module has no side effect.
 */
export function createChainLogScanner(env: NodeJS.ProcessEnv = process.env): ChainLogScanner {
  const client = createPublicClient({ transport: http(resolveRpcUrl(env)) });

  return {
    getLatestBlockNumber() {
      return client.getBlockNumber();
    },
    async scanLogs({ contractAddress, fromBlock, toBlock }) {
      const logs = await client.getLogs({ address: contractAddress, fromBlock, toBlock });
      return logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: log.logIndex ?? 0,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
      }));
    },
    async getBlockHash(blockNumber) {
      try {
        const block = await client.getBlock({ blockNumber });
        return block.hash;
      } catch (error) {
        // viem throws BlockNotFoundError when the requested height no
        // longer exists on the chain (a reorg shortened it) — that is
        // itself a real, expected signal for the caller, not an error to
        // propagate. Any other error (RPC failure, network issue) is a
        // genuine problem and must still surface.
        if (error instanceof BlockNotFoundError) return null;
        throw error;
      }
    },
  };
}
