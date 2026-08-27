import { createPublicClient, http } from "viem";
import { RESULT_SUBMITTED_EVENT_ABI } from "./result-submitted-event.js";

/**
 * One `ResultSubmitted` log found by a block-range scan. Widened (T-905,
 * human review round B) beyond the original discovery-only shape
 * (`taskId`/`transactionHash`) to also carry the block/log identity and
 * `agent` — the poller needs these to populate a
 * `pending_result_submissions` row for a not-yet-final log
 * (repository.ts's `insertPendingResultSubmission`): `logIndex`/
 * `blockHash`/`blockNumber` for the row's own identity and reorg check,
 * `agent` as the `sessionAddress` a poller-discovered promotion passes to
 * `verifyResultSubmission` (safe because `submitResult`, TaskEscrow.sol,
 * already enforces `task.agent == msg.sender` on-chain).
 *
 * Deliberately does NOT also carry the decoded `resultHash`/`submittedAt`/
 * `reviewDeadline` — round B originally included them too, but nothing
 * downstream ever read them: `verifyResultSubmission` (tasks/service.ts),
 * called only once a pending row reaches `resolveRequiredConfirmations()`,
 * always independently re-fetches the receipt and re-decodes the event
 * from scratch before ever promoting a task to `SUBMITTED` — this scan
 * result is a lead to investigate, never itself trusted as a final,
 * confirmed event. Same "never trust the log scanner alone" posture
 * `event-sync.ts` already documents for its own reorg-detection logs.
 */
export interface ResultSubmittedLogEntry {
  taskId: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
  blockHash: `0x${string}`;
  blockNumber: bigint;
  agent: `0x${string}`;
}

/**
 * Separate, narrow interface from `ChainRpcClient` (rpc.client.ts) —
 * deliberately not added as a new method on that shared interface. Every
 * existing test file constructs its own fake `ChainRpcClient` object
 * literal (tx-verifier.test.ts, acceptance-tx-verifier.test.ts,
 * funding.integration.test.ts, acceptance.integration.test.ts,
 * result-submission-tx-verifier.test.ts, result-submission.integration.test.ts);
 * widening that shared interface would force every one of those literals
 * to grow a new stub method it has no use for, just to keep compiling —
 * real blast radius for a capability only the poller needs. This
 * interface's only consumer is `result-submission-poller.ts`.
 */
export interface ResultSubmittedLogScanner {
  scanResultSubmittedLogs(params: {
    contractAddress: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ResultSubmittedLogEntry[]>;
}

const BACKEND_RPC_URL_VAR = "BACKEND_RPC_URL";

function resolveRpcUrl(env: NodeJS.ProcessEnv): string {
  const url = env[BACKEND_RPC_URL_VAR];
  if (!url) {
    throw new Error(
      `${BACKEND_RPC_URL_VAR} is not set. This must be a dedicated backend-only RPC endpoint — ` +
        "see rpc.client.ts's identical check for the full reasoning.",
    );
  }
  return url;
}

/**
 * Real, viem-backed `ResultSubmittedLogScanner` — its own `createPublicClient`
 * (not shared with `rpc.client.ts`'s), same "read `BACKEND_RPC_URL` at call
 * time, not import time" discipline so importing this module has no side
 * effect.
 */
export function createResultSubmittedLogScanner(
  env: NodeJS.ProcessEnv = process.env,
): ResultSubmittedLogScanner {
  const client = createPublicClient({ transport: http(resolveRpcUrl(env)) });

  return {
    async scanResultSubmittedLogs({ contractAddress, fromBlock, toBlock }) {
      const logs = await client.getLogs({
        address: contractAddress,
        event: RESULT_SUBMITTED_EVENT_ABI[0],
        fromBlock,
        toBlock,
      });
      return logs.map((log) => ({
        taskId: log.args.taskId as `0x${string}`,
        transactionHash: log.transactionHash as `0x${string}`,
        logIndex: log.logIndex as number,
        blockHash: log.blockHash as `0x${string}`,
        blockNumber: log.blockNumber as bigint,
        agent: log.args.agent as `0x${string}`,
      }));
    },
  };
}
