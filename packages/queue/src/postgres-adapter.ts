import PgBoss from "pg-boss";
import type { MessageHandler, QueueAdapter, QueueOptions } from "./adapter.js";

/**
 * F-1813's "本地/开源队列" half (design.md 决策 2, 方案 A): `pg-boss` runs
 * entirely on this project's existing PostgreSQL — no new infrastructure
 * dependency for local dev/CI, matching the user's own decision. pg-boss
 * manages its own schema (a dedicated `pgboss` Postgres schema, created on
 * `start()`) — this project does not hand-write that schema (same
 * "adopt the library's own migrations, don't reimplement them" reasoning
 * `migrate.ts`'s own decision record already documents for choosing a
 * library vs a custom migration DSL, applied here to the opposite
 * direction: pg-boss's schema is the one piece of DDL in this project NOT
 * hand-rolled, because unlike this project's own business tables, getting
 * a job queue's internal bookkeeping schema right is pg-boss's own,
 * already-solved problem).
 */
export function createPostgresQueueAdapter(connectionString: string): QueueAdapter {
  const boss = new PgBoss(connectionString);
  let started = false;

  async function ensureStarted(): Promise<void> {
    if (!started) {
      await boss.start();
      started = true;
    }
  }

  return {
    async createQueue(name, options) {
      await ensureStarted();
      // pg-boss's own schema validator rejects a key that's PRESENT with
      // value `undefined` (e.g. `{ deadLetter: undefined }` fails "must be
      // a string", even though omitting the key entirely is valid and
      // means "no DLQ") — a real bug caught by this package's own
      // integration test. Building the options object conditionally, key
      // by key, is what actually omits an unset option rather than
      // including it as `undefined`.
      const pgBossOptions: NonNullable<Parameters<PgBoss["createQueue"]>[1]> = { name };
      if (options?.retryLimit !== undefined) pgBossOptions.retryLimit = options.retryLimit;
      if (options?.deadLetterQueue !== undefined)
        pgBossOptions.deadLetter = options.deadLetterQueue;
      // F-1803: pg-boss's own literal "fixed delay between retry attempts"
      // knob — the direct, native match for this port's `retryDelaySeconds`.
      if (options?.retryDelaySeconds !== undefined)
        pgBossOptions.retryDelay = options.retryDelaySeconds;
      // F-1806 / AC-1804 (T-1804): pg-boss's own literal "how long a job
      // may sit active before being retried/failed" knob — see
      // `adapter.ts`'s own doc comment on `expireInSeconds` for the full
      // "dead worker never gets to signal failure itself" reasoning.
      if (options?.expireInSeconds !== undefined)
        pgBossOptions.expireInSeconds = options.expireInSeconds;
      await boss.createQueue(name, pgBossOptions);
    },

    async publish(queueName, payload) {
      await ensureStarted();
      const id = await boss.send(queueName, payload as object);
      if (!id) {
        throw new Error(
          `createPostgresQueueAdapter.publish: pg-boss returned no job id for queue "${queueName}" ` +
            "(a null return means the send was suppressed, e.g. a debounce/throttle window — this " +
            "adapter never sets those options, so a null here indicates a real, unexpected pg-boss " +
            "behavior change worth investigating rather than silently swallowing).",
        );
      }
      return id;
    },

    async subscribe(queueName, handler) {
      await ensureStarted();
      // batchSize: 1 — one job per work() invocation, so a handler throw
      // fails exactly the one message it was given (pg-boss's default
      // batch semantics fail the WHOLE batch on a throw unless
      // `perJobResults` is used; this adapter's `MessageHandler` contract
      // is per-message, so batchSize:1 is what makes that contract true
      // without pg-boss's own per-job-results protocol leaking into it).
      await boss.work(queueName, { batchSize: 1 }, async (jobs: PgBoss.Job[]) => {
        const job = jobs[0];
        if (!job) return;
        await (handler as MessageHandler)({ id: job.id, payload: job.data });
      });
    },

    async unsubscribe(queueName) {
      await boss.offWork(queueName);
    },

    async stop() {
      if (started) {
        await boss.stop();
        started = false;
      }
    },
  } satisfies QueueAdapter;
}

export type { QueueOptions };
