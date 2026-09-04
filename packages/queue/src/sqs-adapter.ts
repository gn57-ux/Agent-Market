import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import type { MessageHandler, QueueAdapter } from "./adapter.js";

/**
 * F-1813's "生产目标" half (design.md 决策 2 / requirements.md 已确认决定,
 * v1.1): real AWS SQS, with a real SQS-native redrive policy for F-1803's
 * DLQ requirement — not a hand-rolled retry counter, since SQS already
 * provides exactly this natively (`RedrivePolicy` + `maxReceiveCount`) and
 * duplicating that logic in application code would be the same kind of
 * "reimplementing what the platform already solved" this project's own
 * `migrate.ts` decision record argues against for a different library.
 *
 * KNOWN LIMIT, stated plainly rather than hidden: this adapter's code is
 * real (no mocking of the AWS SDK's own request/response shapes), but a
 * genuine end-to-end run — actually creating a queue, sending, and
 * receiving through AWS — requires real AWS credentials this environment
 * does not have. `sqs-adapter.contract.test.ts` verifies this adapter's
 * OWN request-construction logic against a fake `SQSClient.send`, proving
 * "given this SDK response shape, this adapter behaves correctly" without
 * claiming a real AWS round-trip was exercised — see that file's own doc
 * comment, and T-1801's own tasks.md entry, for the explicit scope line
 * separating what was verified from what still needs real AWS access.
 */
export function createSqsQueueAdapter(client: SQSClient): QueueAdapter {
  const queueUrlByName = new Map<string, string>();
  const activeConsumers = new Map<string, { stop: () => void; done: Promise<void> }>();
  /** Populated by `createQueue` when `retryDelaySeconds` is configured —
   * `subscribe`'s own failure path (N4 P2, round 2) needs this to reset a
   * failed message's visibility timeout starting from the failure moment,
   * not just rely on the queue's static VisibilityTimeout attribute alone. */
  const retryDelaySecondsByQueue = new Map<string, number>();

  async function tryResolveQueueUrl(name: string): Promise<string | undefined> {
    const cached = queueUrlByName.get(name);
    if (cached) return cached;
    try {
      const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
      if (QueueUrl) queueUrlByName.set(name, QueueUrl);
      return QueueUrl;
    } catch {
      // AWS's real behavior for an unknown queue name is to reject
      // GetQueueUrl (QueueDoesNotExist), not return an empty result — a
      // real network/permission failure would also land here, but this
      // function's only real caller (createQueue's DLQ pre-check, N4 P2
      // fix below) treats "can't resolve" and "doesn't exist" the same
      // way: attempt to create it.
      return undefined;
    }
  }

  async function resolveQueueUrl(name: string): Promise<string> {
    const url = await tryResolveQueueUrl(name);
    if (!url) {
      throw new Error(
        `createSqsQueueAdapter: GetQueueUrl returned no URL for "${name}" — the queue must be ` +
          "created first via createQueue().",
      );
    }
    return url;
  }

  /**
   * N4 real finding (P1, round 2): the ORIGINAL `createQueue` unconditionally
   * sent a plain `CreateQueueCommand` for the queue being configured
   * (first the DLQ, round 1's own P2 fix already guarded that one — then,
   * still unconditionally, the MAIN queue). SQS's `CreateQueue` is only
   * idempotent when the attributes on the request match the EXISTING
   * queue's attributes exactly; a real deployment that already has the
   * main queue (from a previous run) and calls `createQueue` again with a
   * CHANGED `retryDelaySeconds`/`retryLimit`/`deadLetterQueue` would get
   * `QueueAlreadyExists` and never actually apply the update — silently
   * breaking `createQueue`'s own documented "idempotent: safe to call for
   * a queue that already exists" contract (`adapter.ts`). Fixed with one
   * shared helper used for BOTH the DLQ and the main queue: resolve first
   * — if the queue already exists, apply any configured attributes via
   * `SetQueueAttributesCommand` (a real, idempotent update, not a second
   * creation attempt); if it doesn't exist yet, `CreateQueueCommand` with
   * those attributes from the start.
   */
  async function ensureQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const existingUrl = await tryResolveQueueUrl(name);
    if (existingUrl) {
      if (Object.keys(attributes).length > 0) {
        await client.send(
          new SetQueueAttributesCommand({ QueueUrl: existingUrl, Attributes: attributes }),
        );
      }
      return existingUrl;
    }
    const { QueueUrl } = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      }),
    );
    if (!QueueUrl) {
      throw new Error(
        `createSqsQueueAdapter.createQueue: CreateQueue returned no URL for "${name}"`,
      );
    }
    queueUrlByName.set(name, QueueUrl);
    return QueueUrl;
  }

  async function createQueue(name: string, options?: import("./adapter.js").QueueOptions) {
    let redrivePolicy: string | undefined;
    if (options?.deadLetterQueue) {
      // The DLQ is itself just a plain queue (no further redrive chain —
      // a DLQ's own messages are inspected/replayed by an operator, not
      // auto-retried again). Recurses via the plain function, not a
      // `this.createQueue(...)` method call, so this doesn't depend on
      // the returned QueueAdapter object being invoked with any
      // particular `this` binding at the call site.
      const dlqUrl = await ensureQueue(options.deadLetterQueue, {});
      const { Attributes } = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
      );
      const dlqArn = Attributes?.QueueArn;
      if (!dlqArn) {
        throw new Error(
          `createSqsQueueAdapter.createQueue: could not resolve QueueArn for dead letter ` +
            `queue "${options.deadLetterQueue}"`,
        );
      }
      // N4 real finding (P2, round 1): SQS's `maxReceiveCount` counts the
      // TOTAL number of times a message may be received — including the
      // first, non-retry attempt — whereas this port's own `retryLimit`
      // means "how many times to retry AFTER the first failure" (pg-boss's
      // own documented semantics for the identical field, which this
      // port's doc comment already inherits). Passing `retryLimit`
      // straight through as `maxReceiveCount` would move a message to the
      // DLQ one attempt earlier than the Postgres adapter does for the
      // same `retryLimit` value — e.g. `retryLimit: 1` means "1 retry, 2
      // total attempts" on Postgres but would mean "1 total attempt, 0
      // retries" on SQS. `+ 1` aligns the two adapters' observable
      // behavior for the same configured `retryLimit`, matching this
      // port's own "same consumer interface, consistent behavior across
      // both adapters" requirement (AC's own "行为一致").
      const maxReceiveCount = (options.retryLimit ?? 4) + 1;
      redrivePolicy = JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount,
      });
    }

    // F-1803: SQS has no literal "delay before retry" knob the way
    // pg-boss's `retryDelay` does — its native equivalent is the queue's
    // own `VisibilityTimeout`, which governs how long ANY received
    // message (first attempt or retry) stays invisible before becoming
    // eligible for redelivery. Setting it from `retryDelaySeconds` is the
    // closest real match SQS offers for this port's shared config knob
    // (see `adapter.ts`'s own doc comment on `retryDelaySeconds` for the
    // full reasoning on why the two adapters' underlying mechanisms
    // differ while producing the same observable behavior — and
    // `subscribe`'s own N4 P2 round-2 fix below for why that alone isn't
    // sufficient).
    const attributes: Record<string, string> = {};
    if (redrivePolicy) attributes.RedrivePolicy = redrivePolicy;
    if (options?.retryDelaySeconds !== undefined) {
      attributes.VisibilityTimeout = String(options.retryDelaySeconds);
      retryDelaySecondsByQueue.set(name, options.retryDelaySeconds);
    }

    await ensureQueue(name, attributes);
  }

  return {
    createQueue,

    async publish(queueName, payload) {
      const queueUrl = await resolveQueueUrl(queueName);
      const { MessageId } = await client.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(payload) }),
      );
      if (!MessageId) {
        throw new Error(
          `createSqsQueueAdapter.publish: SendMessage returned no MessageId for "${queueName}"`,
        );
      }
      return MessageId;
    },

    async subscribe(queueName, handler) {
      // N4 real finding (P1): subscribing twice for the same queue used
      // to overwrite `activeConsumers`'s entry outright — the FIRST
      // polling loop kept running (nothing had told it to stop), but was
      // no longer reachable through `unsubscribe`/`stop` (which only ever
      // look up the CURRENT map entry), leaking an orphaned loop that
      // holds a connection and keeps processing messages indefinitely.
      // Fixed by stopping and fully awaiting any existing consumer for
      // this queue before starting the new one — same
      // stop()-then-await-done sequence `unsubscribe()` itself already
      // uses, so a second `subscribe()` call is a clean handoff, not a
      // leak.
      const existing = activeConsumers.get(queueName);
      if (existing) {
        existing.stop();
        await existing.done;
        activeConsumers.delete(queueName);
      }

      const queueUrl = await resolveQueueUrl(queueName);
      let running = true;

      const loop = (async () => {
        // N4 real finding (P1, round 2): a transient `ReceiveMessageCommand`
        // failure (network blip, throttling, momentary AWS unavailability)
        // previously propagated straight out of this loop, permanently
        // ending consumption — `subscribe()` has already returned to its
        // caller by this point, so the rejection had nobody left to catch
        // it (an unhandled rejection), and the queue silently stopped
        // being consumed with no crash and no visible error. This violates
        // F-1812's own requirement ("RPC 中断恢复...不崩溃退出，按退避策略
        // 重连") — the same reconnect-don't-crash discipline this project's
        // `apps/indexer` polling loop is held to. Fixed by catching a
        // receive failure specifically, backing off, and continuing the
        // loop rather than letting it propagate — `running` (flipped by
        // `unsubscribe`/`stop`) is still checked every iteration, so a
        // real shutdown request still stops the loop cleanly instead of
        // retrying forever.
        while (running) {
          let messages: Message[] | undefined;
          try {
            const response = await client.send(
              new ReceiveMessageCommand({
                QueueUrl: queueUrl,
                MaxNumberOfMessages: 1,
                // Long polling — avoids a tight empty-queue request loop;
                // also the standard SQS-recommended way to reduce cost and
                // latency versus short polling.
                WaitTimeSeconds: 20,
              }),
            );
            messages = response.Messages;
          } catch {
            if (!running) break;
            // Brief backoff before retrying — avoids hammering AWS (or a
            // consistently-erroring endpoint) with an immediate tight
            // retry loop while still recovering promptly once the
            // transient condition clears.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }

          for (const message of messages ?? []) {
            if (!message.ReceiptHandle || !message.MessageId) continue;
            try {
              const payload: unknown = message.Body ? JSON.parse(message.Body) : null;
              await (handler as MessageHandler)({ id: message.MessageId, payload });
              await client.send(
                new DeleteMessageCommand({
                  QueueUrl: queueUrl,
                  ReceiptHandle: message.ReceiptHandle,
                }),
              );
            } catch {
              // Deliberately no DeleteMessageCommand: leaving the message
              // un-deleted lets its SQS visibility timeout expire, making
              // it visible for redelivery — SQS's own native at-least-once
              // retry mechanism, and (via the queue's RedrivePolicy set in
              // createQueue) its own native path to the DLQ once
              // maxReceiveCount is exceeded. No application-level retry
              // counter is reimplemented here. This catch also absorbs a
              // DeleteMessageCommand failure after a successful handler
              // run — the message simply gets redelivered and the handler
              // runs again, which the handler's own idempotency (T-1802)
              // is what makes safe, not a retry counter here.
              //
              // N4 real finding (P2, round 2): the queue's static
              // VisibilityTimeout attribute (set once, at createQueue time)
              // starts counting from when SQS returns the message via
              // ReceiveMessage — NOT from when the handler actually fails.
              // A handler that runs for a meaningful fraction of
              // `retryDelaySeconds` before throwing would leave the
              // message eligible for redelivery almost immediately after
              // failure, rather than backing off for the full configured
              // delay — diverging from pg-boss's own `retryDelay` (which
              // genuinely starts its delay at failure time) and from this
              // port's own documented `retryDelaySeconds` contract. Fixed
              // by explicitly resetting visibility to the full configured
              // delay, starting NOW, right after the handler failed —
              // `ChangeMessageVisibilityCommand` is SQS's real mechanism
              // for exactly this. A failure here (e.g. the message was
              // already deleted or its receipt handle expired) is itself
              // swallowed — the message's fate is already determined by
              // SQS's own state at that point, not by this best-effort
              // adjustment.
              const retryDelaySeconds = retryDelaySecondsByQueue.get(queueName);
              if (retryDelaySeconds !== undefined) {
                try {
                  await client.send(
                    new ChangeMessageVisibilityCommand({
                      QueueUrl: queueUrl,
                      ReceiptHandle: message.ReceiptHandle,
                      VisibilityTimeout: retryDelaySeconds,
                    }),
                  );
                } catch {
                  // best-effort — see comment above
                }
              }
            }
          }
        }
      })();

      activeConsumers.set(queueName, {
        stop: () => {
          running = false;
        },
        done: loop,
      });
    },

    async unsubscribe(queueName) {
      const consumer = activeConsumers.get(queueName);
      if (!consumer) return;
      consumer.stop();
      await consumer.done;
      activeConsumers.delete(queueName);
    },

    async stop() {
      for (const [, consumer] of activeConsumers) {
        consumer.stop();
      }
      await Promise.all([...activeConsumers.values()].map((consumer) => consumer.done));
      activeConsumers.clear();
      client.destroy();
    },
  } satisfies QueueAdapter;
}
