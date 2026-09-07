import { resolveChainConfig } from "@agent-market/domain";
import { buildApp } from "./app.js";
import { getPool } from "./db/pool.js";
import { hydrateAgentCredentialsFromManager, hydrateSecretsFromManager } from "./config/secrets.js";
import { createChainRpcClient } from "./modules/chain/rpc.client.js";
import { createResultSubmittedLogScanner } from "./modules/chain/result-submitted-log-scanner.js";
import { verifySignerMatchesContract } from "./modules/dispatch/permit.service.js";
import {
  startResultSubmissionPoller,
  type ResultSubmissionPollerHandle,
} from "./modules/tasks/result-submission-poller.js";
import { startDagPoller, type DagPollerHandle } from "./modules/dag/dag-poller.js";
import { LangGraphDagExecutor } from "./modules/dag/langgraph-executor.js";
import {
  startReleaseStagePoller,
  type ReleaseStagePollerHandle,
} from "./modules/ctr-training/release-stage-poller.js";

// T-2301 (F-2303): must complete BEFORE `buildApp()` — `buildApp()` itself
// calls `getPool()` synchronously (reads `DATABASE_URL`) and reads
// `PRIVY_APP_SECRET` while registering the auth module, so both need
// `process.env` already hydrated. This is why `app`/`port` moved from
// top-level `const`s into `main()`'s local scope: a top-level `buildApp()`
// call runs at import time, before any `await` in this file could ever
// run first.
let app: ReturnType<typeof buildApp>;
let port: number;
let resultSubmissionPollerHandle: ResultSubmissionPollerHandle | undefined;
let dagPollerHandle: DagPollerHandle | undefined;
let releaseStagePollerHandle: ReleaseStagePollerHandle | undefined;

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

  // T-1703 (N4 real finding: the DAG state-advancement logic existed but
  // was never actually invoked anywhere outside tests — see
  // dag-poller.ts's own doc comment for the full "临时同步轮询" rationale
  // and why this mirrors startResultSubmissionPoller's shape exactly).
  // Doesn't need `resolveChainConfig`/an RPC client of its own —
  // `advanceDag` only reads `tasks.status` from Postgres (already updated
  // by Feature 10's own settlement paths) and `YD_TOKEN_ADDRESS` from env,
  // same as `POST /dags/:dagId/activate` itself.
  dagPollerHandle = startDagPoller({
    pool: getPool(),
    // T-1709/Q-1701 (v1.1, 用户定稿): the DagExecutor to use is an
    // environment-gated choice, not a code branch — `DAG_EXECUTOR=langgraph`
    // opts a running deployment into `LangGraphDagExecutor` (which itself
    // does nothing but call the exact same `advanceDag` this default calls
    // — see that class's own doc comment); any other value (including
    // unset) keeps the default `SimpleDagExecutor` this poller has always
    // used, so this change cannot alter production behavior unless someone
    // deliberately sets the env var.
    executor: process.env.DAG_EXECUTOR === "langgraph" ? new LangGraphDagExecutor() : undefined,
    onTick: (summary) => {
      if (
        summary.activatedNodeCount > 0 ||
        summary.completedDagIds.length > 0 ||
        summary.blockedDagIds.length > 0 ||
        summary.errors.length > 0
      ) {
        app.log.info({ summary }, "dag poller tick");
      }
    },
    onError: (error) => {
      app.log.error({ err: error }, "dag poller tick failed");
    },
  });

  // T-1907 (F-1910/F-1916), N4 round 2 real finding (P1): the automatic
  // rollback logic (`release-gate.ts`'s `checkAndAutoRollback`) previously
  // had no real periodic trigger — only a manual CLI invocation. Same
  // "nothing calls the real state-transition logic on its own" gap
  // T-905/T-1703 already closed for their own logic, closed here the same
  // way — see `release-stage-poller.ts`'s own doc comment.
  releaseStagePollerHandle = startReleaseStagePoller({
    pool: getPool(),
    onTick: (result) => {
      if (result?.rolledBack) {
        app.log.warn({ result }, "release stage auto-rollback triggered");
      }
    },
    onError: (error) => {
      app.log.error({ err: error }, "release stage poller tick failed");
    },
  });
}

async function stopBackgroundPollers(): Promise<void> {
  // Awaited (T-905, round B, P2): `stop()` now drains any in-flight tick
  // before resolving — see `ResultSubmissionPollerHandle.stop()`'s own doc
  // comment for why a fire-and-forget call here was unsafe (an in-flight
  // tick could still touch `pool`/`rpc` after `shutdown` proceeds to
  // `app.close()` below). Same reasoning applies to `dagPollerHandle`.
  await resultSubmissionPollerHandle?.stop();
  resultSubmissionPollerHandle = undefined;
  await dagPollerHandle?.stop();
  dagPollerHandle = undefined;
  await releaseStagePollerHandle?.stop();
  releaseStagePollerHandle = undefined;
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

async function main(): Promise<void> {
  // T-2301: must run before `buildApp()` — see this file's top-of-file
  // comment on why `app`/`port` are no longer top-level `const`s.
  await hydrateSecretsFromManager();

  app = buildApp();
  port = Number(process.env.API_PORT ?? 3001);
  // T-2301 (N4 round 2 P1): dynamic per-Agent credential names
  // (`env://AGENT_<id>`) can't be listed statically — see
  // `hydrateAgentCredentialsFromManager`'s own doc comment. `buildApp()`
  // already created the pool `getPool()` now returns, and this must
  // complete before `app.listen()` starts accepting invocation traffic.
  await hydrateAgentCredentialsFromManager(getPool());

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

  await verifyStartupSignerConfig();
  startBackgroundPollers();
  await app.listen({ port, host: "0.0.0.0" });
}

// Before `app` exists (a secrets-hydration failure), fall back to
// `console.error` — same reasoning `app.log.error` couldn't apply here
// even before this Task, just now reachable slightly earlier in startup.
main().catch((error) => {
  if (app) {
    app.log.error(error);
  } else {
    console.error(error);
  }
  process.exit(1);
});
