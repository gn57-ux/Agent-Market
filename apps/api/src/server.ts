import { resolveChainConfig } from "@agent-market/domain";
import { buildApp } from "./app.js";
import { getPool } from "./db/pool.js";
import { createChainRpcClient } from "./modules/chain/rpc.client.js";
import { createResultSubmittedLogScanner } from "./modules/chain/result-submitted-log-scanner.js";
import { verifySignerMatchesContract } from "./modules/dispatch/permit.service.js";
import {
  startResultSubmissionPoller,
  type ResultSubmissionPollerHandle,
} from "./modules/tasks/result-submission-poller.js";

const app = buildApp();
const port = Number(process.env.API_PORT ?? 3001);
let resultSubmissionPollerHandle: ResultSubmissionPollerHandle | undefined;

/**
 * Startup gate (Feature 7 sync, T-709, P1): confirms
 * `ACCEPTANCE_PERMIT_SIGNER_KEY` actually matches the deployed `TaskEscrow`
 * contract's `authorizedSigner()` before this process starts accepting
 * traffic — see `permit.service.ts`'s `verifySignerMatchesContract` doc
 * comment for why. A missing
 * `BACKEND_RPC_URL`/`TASK_ESCROW_ADDRESS`/`ACCEPTANCE_PERMIT_SIGNER_KEY`
 * surfaces here too, via the existing clear errors `createChainRpcClient`/
 * `resolveChainConfig`/`loadSignerAccount` already throw — this function
 * doesn't reimplement that env-validation, it only adds the "do the two
 * addresses actually match" check on top once everything required is
 * present.
 */
async function verifyStartupSignerConfig(): Promise<void> {
  const { addresses } = resolveChainConfig(process.env);
  const rpc = createChainRpcClient();
  await verifySignerMatchesContract(rpc, addresses.taskEscrow);
}

/**
 * T-905 (N4 round 1 P1, Codex): starts the background poller that syncs
 * `ResultSubmitted` events independent of any client calling
 * `POST /tasks/:taskId/result-verifications` — see
 * `result-submission-poller.ts`'s own doc comment for why this exists and
 * how it stays safe to re-scan on every tick. Started once, after the
 * signer-config gate and before `app.listen()` begins accepting traffic,
 * so a startup failure in chain-config resolution surfaces the same way
 * `verifyStartupSignerConfig` already does, rather than half-starting.
 *
 * The returned handle is stored at module scope so `stopBackgroundPollers`
 * (below) can actually stop the interval on shutdown — human N4 follow-up
 * (T-905, round-cap already exhausted): nothing previously called
 * `handle.stop()` anywhere, so the timer would keep firing (against a pool
 * `app.close()` may already be tearing down) for as long as the process
 * kept running past a graceful-shutdown signal.
 */
function startBackgroundPollers(): void {
  const { addresses, chainId } = resolveChainConfig(process.env);
  resultSubmissionPollerHandle = startResultSubmissionPoller({
    pool: getPool(),
    rpc: createChainRpcClient(),
    scanner: createResultSubmittedLogScanner(),
    contractAddress: addresses.taskEscrow,
    chainId,
    onTick: (summary) => {
      if (summary.candidatesFound > 0 || summary.rolledBack > 0 || summary.errors.length > 0) {
        app.log.info({ summary }, "result-submission poller tick");
      }
    },
    onError: (error) => {
      app.log.error({ err: error }, "result-submission poller tick failed");
    },
  });
}

async function stopBackgroundPollers(): Promise<void> {
  // Awaited (T-905, round B, P2): `stop()` now drains any in-flight tick
  // before resolving — see `ResultSubmissionPollerHandle.stop()`'s own doc
  // comment for why a fire-and-forget call here was unsafe (an in-flight
  // tick could still touch `pool`/`rpc` after `shutdown` proceeds to
  // `app.close()` below).
  await resultSubmissionPollerHandle?.stop();
  resultSubmissionPollerHandle = undefined;
}

async function start(): Promise<void> {
  await verifyStartupSignerConfig();
  startBackgroundPollers();
  await app.listen({ port, host: "0.0.0.0" });
}

/**
 * Graceful shutdown (human N4 follow-up, T-905): stops the poller BEFORE
 * closing the Fastify instance (which itself closes the shared `pool` via
 * its own lifecycle) — the ordering matters, since a poller tick still in
 * flight when the pool closes would fail with a confusing "pool has
 * ended" error instead of this clean, intentional stop.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await stopBackgroundPollers();
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", (signal) => {
  shutdown(signal).catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
});
process.on("SIGINT", (signal) => {
  shutdown(signal).catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
});

// Same failure-exit path for both the signer check and listen() failing —
// no new failure-handling mechanism invented for this new startup step.
start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
