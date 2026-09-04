import { Pool } from "pg";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  createPostgresIdempotencyLedger,
  createPostgresQueueAdapter,
  createSqsQueueAdapter,
  withIdempotentConsumption,
  type EventEnvelope,
  type QueueAdapter,
} from "@agent-market/queue";

/**
 * F-1806 / T-1804: the independent Worker deployment unit — a real,
 * separate Node process from `apps/api`'s HTTP server, consuming from a
 * real queue via `@agent-market/queue` (the same package `apps/api`'s own
 * relay/outbox tests already exercise against real Postgres/pg-boss and
 * real AWS SDK command construction — T-1801/T-1802/T-1803).
 *
 * SCOPE, stated plainly (DEFERRED-ENGINEERING's "只为真实消费者建设"):
 * Feature 17's own DAG node-advancement logic has NOT been rewired to
 * publish through the outbox/queue yet — it still runs via
 * `dag-poller.ts`'s synchronous polling inside `apps/api` itself
 * (`specs/PLAN.md`'s own recorded technical debt entry for Feature 17).
 * There is therefore no REAL business handler this Task can wire in yet
 * — inventing one would mean maintaining a second, parallel, untested
 * "DAG advancement via queue" path nobody actually uses, which is exactly
 * what that principle exists to prevent. What IS real and this Task's own
 * actual scope: the independent PROCESS itself — its own lifecycle,
 * startup, graceful shutdown, and a genuinely working consume-with-
 * idempotency pipeline — verified by AC-1804's own literal text, which is
 * about process independence (kill/restart, API unaffected), not about
 * any specific business payload. The registered handler below is a real,
 * minimal, honestly-scoped placeholder (structurally logs receipt via the
 * real idempotent-consumption pipeline) that a future real business
 * consumer replaces without needing to touch anything else in this file.
 */

/**
 * N4 real finding (P1): the original version of this function unconditionally
 * threw for `QUEUE_ADAPTER=sqs`, meaning the advertised production queue
 * backend (design.md's own decision 2 / requirements.md's v1.1 "已确认决定":
 * Postgres locally, SQS in production) could never actually run — a real
 * deployment target setting that env var would find the Worker permanently
 * refusing to start. The earlier reasoning conflated two different things:
 * "a genuine END-TO-END verification of this code path needs real AWS
 * credentials this environment doesn't have" (still true, and still why
 * `packages/queue`'s own SQS tests stay contract-level, not live-AWS) does
 * NOT mean "the code path itself must be unreachable" — constructing an
 * `SQSClient` needs no credentials at construction time; the AWS SDK's own
 * default credential provider chain resolves them lazily, only when an
 * actual API call is made. A real deployment target (with real IAM
 * credentials present in its own environment, however they're supplied —
 * env vars, an instance role, etc.) can genuinely run this path; this
 * environment simply has no such credentials to verify it end-to-end with,
 * which is a real, separate, already-documented gap (see `packages/queue`'s
 * own SQS adapter files), not a reason to block the code path outright.
 */
function resolveQueueAdapter(env: NodeJS.ProcessEnv): QueueAdapter {
  const kind = env.QUEUE_ADAPTER ?? "postgres";
  if (kind === "sqs") {
    // AWS SDK v3's own default credential provider chain (env vars, a
    // shared credentials file, an EC2/ECS/Lambda instance role, ...)
    // resolves credentials lazily on first real API call — this
    // constructor never itself requires credentials to be present.
    const client = new SQSClient({ region: env.AWS_REGION });
    return createSqsQueueAdapter(client);
  }
  const connectionString = requireDatabaseUrl(env);
  return createPostgresQueueAdapter(connectionString);
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env at the repo root — apps/worker's " +
        "dev/start scripts load it automatically via --env-file-if-exists.",
    );
  }
  return url;
}

const QUEUE_NAME = process.env.WORKER_QUEUE_NAME ?? "worker-events";
const DLQ_NAME = process.env.WORKER_DLQ_NAME ?? "worker-events-dlq";
const CONSUMER_NAME = "worker";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl(process.env) });
  const queue = resolveQueueAdapter(process.env);

  await queue.createQueue(DLQ_NAME);
  await queue.createQueue(QUEUE_NAME, {
    deadLetterQueue: DLQ_NAME,
    retryLimit: process.env.WORKER_RETRY_LIMIT ? Number(process.env.WORKER_RETRY_LIMIT) : undefined,
    retryDelaySeconds: process.env.WORKER_RETRY_DELAY_SECONDS
      ? Number(process.env.WORKER_RETRY_DELAY_SECONDS)
      : undefined,
    expireInSeconds: process.env.WORKER_EXPIRE_SECONDS
      ? Number(process.env.WORKER_EXPIRE_SECONDS)
      : undefined,
  });

  const ledger = createPostgresIdempotencyLedger(pool, CONSUMER_NAME);
  const handler = withIdempotentConsumption<unknown, unknown>(ledger, async (payload) => {
    console.log(`apps/worker consumed event, payload=${JSON.stringify(payload)}`);
  });

  await queue.subscribe<EventEnvelope<unknown>>(QUEUE_NAME, handler);
  console.log(`apps/worker started: consuming "${QUEUE_NAME}" (DLQ "${DLQ_NAME}")`);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`apps/worker received ${signal}, shutting down`);
    await queue.unsubscribe(QUEUE_NAME);
    await queue.stop();
    await pool.end();
    process.exit(0);
  }
  process.on("SIGTERM", (signal) => void shutdown(signal));
  process.on("SIGINT", (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  console.error("apps/worker fatal error:", error);
  process.exit(1);
});
