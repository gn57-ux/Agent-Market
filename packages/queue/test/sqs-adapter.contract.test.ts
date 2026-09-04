import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqsQueueAdapter } from "../src/sqs-adapter.js";

/**
 * A real end-to-end SQS run needs real AWS credentials this environment
 * does not have (requirements.md's own risk section flags this explicitly
 * as a "pause and ask the user" condition, not something to fake). What
 * IS verified here, against the real `@aws-sdk/client-sqs` command
 * classes (not a hand-rolled mock of AWS's request shape): that
 * `createSqsQueueAdapter` constructs the RIGHT commands with the RIGHT
 * parameters for each operation — a fake `SQSClient.send` records which
 * real `*Command` instances it received and returns scripted responses,
 * the same contract a real `SQSClient` would fulfill. This is a genuine
 * logic proof, just not a network proof.
 */
function fakeClient(
  handlers: Partial<{
    [
      K in
        | "CreateQueueCommand"
        | "GetQueueUrlCommand"
        | "GetQueueAttributesCommand"
        | "SetQueueAttributesCommand"
        | "SendMessageCommand"
        | "ReceiveMessageCommand"
        | "DeleteMessageCommand"
        | "ChangeMessageVisibilityCommand"
    ]: (command: unknown) => unknown;
  }>,
): SQSClient {
  const client = new SQSClient({
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "y" },
  });
  vi.spyOn(client, "send").mockImplementation(async (command: unknown) => {
    const ctorName = (command as { constructor: { name: string } }).constructor.name;
    const handler = handlers[ctorName as keyof typeof handlers];
    if (!handler) throw new Error(`fakeClient: no handler registered for ${ctorName}`);
    return handler(command);
  });
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSqsQueueAdapter", () => {
  it("createQueue without a DLQ sends a plain CreateQueueCommand with no RedrivePolicy", async () => {
    const createCalls: CreateQueueCommand[] = [];
    const client = fakeClient({
      CreateQueueCommand: (command) => {
        createCalls.push(command as CreateQueueCommand);
        return { QueueUrl: "https://sqs.example/plain-queue" };
      },
    });
    const adapter = createSqsQueueAdapter(client);

    await adapter.createQueue("plain-queue");

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.input.QueueName).toBe("plain-queue");
    expect(createCalls[0]?.input.Attributes).toBeUndefined();
  });

  it("createQueue with a deadLetterQueue creates the DLQ first, resolves its ARN, then sets RedrivePolicy on the main queue with maxReceiveCount = retryLimit + 1", async () => {
    const createCalls: CreateQueueCommand[] = [];
    // Stateful: GetQueueUrl only succeeds for a name that has ALREADY been
    // created — matching real SQS (GetQueueUrl fails for a queue that
    // doesn't exist yet). Without this, a permissive fake would make the
    // N4 P2 pre-existence check (tryResolveQueueUrl) believe the DLQ
    // already exists before it's ever created, skipping creation entirely.
    const createdQueueNames = new Set<string>();
    const client = fakeClient({
      CreateQueueCommand: (command) => {
        const typed = command as CreateQueueCommand;
        createCalls.push(typed);
        createdQueueNames.add(typed.input.QueueName ?? "");
        return { QueueUrl: `https://sqs.example/${typed.input.QueueName}` };
      },
      GetQueueUrlCommand: (command) => {
        const name = (command as GetQueueUrlCommand).input.QueueName ?? "";
        if (!createdQueueNames.has(name)) {
          throw new Error("simulated AWS.SimpleQueueService.NonExistentQueue");
        }
        return { QueueUrl: `https://sqs.example/${name}` };
      },
      GetQueueAttributesCommand: () => ({
        Attributes: { QueueArn: "arn:aws:sqs:us-east-1:1:my-dlq" },
      }),
    });
    const adapter = createSqsQueueAdapter(client);

    await adapter.createQueue("main-queue", { deadLetterQueue: "my-dlq", retryLimit: 3 });

    expect(createCalls.map((c) => c.input.QueueName)).toEqual(["my-dlq", "main-queue"]);
    const mainQueueCreate = createCalls[1];
    const redrivePolicy = JSON.parse(mainQueueCreate?.input.Attributes?.RedrivePolicy ?? "{}");
    // N4 real finding (P2): SQS's maxReceiveCount counts the first attempt
    // too, so retryLimit:3 (3 retries AFTER the first attempt, matching
    // pg-boss's own semantics) must become maxReceiveCount:4, not 3.
    expect(redrivePolicy).toEqual({
      deadLetterTargetArn: "arn:aws:sqs:us-east-1:1:my-dlq",
      maxReceiveCount: 4,
    });
  });

  it("F-1803: retryDelaySeconds maps to the queue's own VisibilityTimeout attribute", async () => {
    const createCalls: CreateQueueCommand[] = [];
    const client = fakeClient({
      CreateQueueCommand: (command) => {
        createCalls.push(command as CreateQueueCommand);
        return { QueueUrl: "https://sqs.example/backoff-queue" };
      },
    });
    const adapter = createSqsQueueAdapter(client);

    await adapter.createQueue("backoff-queue", { retryDelaySeconds: 30 });

    expect(createCalls[0]?.input.Attributes?.VisibilityTimeout).toBe("30");
  });

  it("N4 real finding (P2, round 1): does not re-create an already-existing DLQ (which would fail with QueueAlreadyExists on a real attribute mismatch)", async () => {
    const createCalls: CreateQueueCommand[] = [];
    // Stateful: only "pre-existing-dlq" resolves via GetQueueUrl (as its
    // name says, it already exists); "main-queue" does not yet exist and
    // must genuinely go through CreateQueueCommand — matching real SQS,
    // where GetQueueUrl fails for a queue that was never created.
    const preExistingNames = new Set(["pre-existing-dlq"]);
    const client = fakeClient({
      GetQueueUrlCommand: (command) => {
        const name = (command as GetQueueUrlCommand).input.QueueName ?? "";
        if (!preExistingNames.has(name)) {
          throw new Error("simulated AWS.SimpleQueueService.NonExistentQueue");
        }
        return { QueueUrl: `https://sqs.example/${name}` };
      },
      GetQueueAttributesCommand: () => ({
        Attributes: { QueueArn: "arn:aws:sqs:us-east-1:1:pre-existing-dlq" },
      }),
      CreateQueueCommand: (command) => {
        createCalls.push(command as CreateQueueCommand);
        return {
          QueueUrl: `https://sqs.example/${(command as CreateQueueCommand).input.QueueName}`,
        };
      },
    });
    const adapter = createSqsQueueAdapter(client);

    await adapter.createQueue("main-queue", { deadLetterQueue: "pre-existing-dlq" });

    // Only the MAIN queue was actually created — the DLQ, already
    // resolvable, was never sent a CreateQueueCommand at all.
    expect(createCalls.map((c) => c.input.QueueName)).toEqual(["main-queue"]);
  });

  it("N4 real finding (P1, round 2): calling createQueue again for an ALREADY-EXISTING main queue applies changed attributes via SetQueueAttributes, not a second CreateQueue attempt", async () => {
    const createCalls: CreateQueueCommand[] = [];
    const setAttributesCalls: unknown[] = [];
    const client = fakeClient({
      GetQueueUrlCommand: (command) => ({
        QueueUrl: `https://sqs.example/${(command as GetQueueUrlCommand).input.QueueName}`,
      }),
      CreateQueueCommand: (command) => {
        createCalls.push(command as CreateQueueCommand);
        return {
          QueueUrl: `https://sqs.example/${(command as CreateQueueCommand).input.QueueName}`,
        };
      },
      SetQueueAttributesCommand: (command) => {
        setAttributesCalls.push(command);
        return {};
      },
    });
    const adapter = createSqsQueueAdapter(client);

    // A second createQueue call for a queue that already resolves (real
    // deployment re-running against an already-provisioned queue), with a
    // changed retryDelaySeconds — before the fix this would have retried
    // CreateQueueCommand and, against real AWS, failed with
    // QueueAlreadyExists instead of applying the update.
    await adapter.createQueue("main-queue", { retryDelaySeconds: 45 });

    expect(createCalls).toHaveLength(0);
    expect(setAttributesCalls).toHaveLength(1);
  });

  it("publish sends a SendMessageCommand with the JSON-serialized payload and returns the real MessageId", async () => {
    const sendCalls: SendMessageCommand[] = [];
    const client = fakeClient({
      GetQueueUrlCommand: () => ({ QueueUrl: "https://sqs.example/q" }),
      SendMessageCommand: (command) => {
        sendCalls.push(command as SendMessageCommand);
        return { MessageId: "real-message-id-123" };
      },
    });
    const adapter = createSqsQueueAdapter(client);

    const id = await adapter.publish("q", { taskId: "abc", budget: "1000000000000000000" });

    expect(id).toBe("real-message-id-123");
    expect(sendCalls[0]?.input.QueueUrl).toBe("https://sqs.example/q");
    expect(JSON.parse(sendCalls[0]?.input.MessageBody ?? "")).toEqual({
      taskId: "abc",
      budget: "1000000000000000000",
    });
  });

  it("subscribe: on handler success, deletes the message (real DeleteMessageCommand); on handler throw, leaves it for SQS's own visibility-timeout redelivery", async () => {
    let receiveCallCount = 0;
    const deleteCalls: DeleteMessageCommand[] = [];
    const client = fakeClient({
      GetQueueUrlCommand: () => ({ QueueUrl: "https://sqs.example/q" }),
      ReceiveMessageCommand: () => {
        receiveCallCount += 1;
        if (receiveCallCount === 1) {
          return {
            Messages: [
              {
                MessageId: "m1",
                ReceiptHandle: "rh1",
                Body: JSON.stringify({ ok: true }),
              },
            ],
          };
        }
        if (receiveCallCount === 2) {
          return {
            Messages: [
              {
                MessageId: "m2",
                ReceiptHandle: "rh2",
                Body: JSON.stringify({ ok: false }),
              },
            ],
          };
        }
        // Real SQS's `WaitTimeSeconds` blocks server-side for up to that
        // duration when there's nothing to return — the adapter's polling
        // loop has no application-level pacing of its own because it
        // relies entirely on that real blocking behavior. A fake that
        // resolves empty results instantly breaks that assumption and
        // spins the loop into an out-of-memory crash (a real failure this
        // test's first draft actually hit) — so this fake simulates the
        // same blocking wait a real long-poll would provide.
        return new Promise((resolve) => setTimeout(() => resolve({ Messages: [] }), 50));
      },
      DeleteMessageCommand: (command) => {
        deleteCalls.push(command as DeleteMessageCommand);
        return {};
      },
    });
    const adapter = createSqsQueueAdapter(client);

    const seen: unknown[] = [];
    await adapter.subscribe("q", async (message) => {
      seen.push(message.payload);
      if ((message.payload as { ok: boolean }).ok === false) {
        throw new Error("simulated handler failure");
      }
    });

    // Let the polling loop process both scripted receives (the first two
    // calls resolve immediately; only the third+ calls carry the fake's
    // 50ms simulated long-poll wait).
    await new Promise((resolve) => setTimeout(resolve, 30));
    await adapter.unsubscribe("q");

    expect(seen).toEqual([{ ok: true }, { ok: false }]);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.input.ReceiptHandle).toBe("rh1");
  });

  it("N4 real finding (P2, round 2): a handler failure resets the message's visibility timeout to the configured retryDelaySeconds, starting from the failure moment", async () => {
    const changeVisibilityCalls: unknown[] = [];
    let queueCreated = false;
    const client = fakeClient({
      GetQueueUrlCommand: () => {
        if (!queueCreated) throw new Error("simulated AWS.SimpleQueueService.NonExistentQueue");
        return { QueueUrl: "https://sqs.example/q" };
      },
      CreateQueueCommand: () => {
        queueCreated = true;
        return { QueueUrl: "https://sqs.example/q" };
      },
      ReceiveMessageCommand: () => {
        if (changeVisibilityCalls.length === 0) {
          return {
            Messages: [
              { MessageId: "m1", ReceiptHandle: "rh1", Body: JSON.stringify({ fail: true }) },
            ],
          };
        }
        return new Promise((resolve) => setTimeout(() => resolve({ Messages: [] }), 50));
      },
      ChangeMessageVisibilityCommand: (command) => {
        changeVisibilityCalls.push(command);
        return {};
      },
    });
    const adapter = createSqsQueueAdapter(client);
    await adapter.createQueue("q", { retryDelaySeconds: 45 });

    await adapter.subscribe("q", async () => {
      throw new Error("simulated handler failure");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await adapter.unsubscribe("q");

    expect(changeVisibilityCalls).toHaveLength(1);
    expect(changeVisibilityCalls[0]).toMatchObject({
      input: { QueueUrl: "https://sqs.example/q", ReceiptHandle: "rh1", VisibilityTimeout: 45 },
    });
  });

  it("N4 P1 fix (round 2): a transient ReceiveMessageCommand failure does not permanently stop consumption, and unsubscribe still resolves cleanly afterward", async () => {
    let receiveCallCount = 0;
    const client = fakeClient({
      GetQueueUrlCommand: () => ({ QueueUrl: "https://sqs.example/q" }),
      ReceiveMessageCommand: () => {
        receiveCallCount += 1;
        if (receiveCallCount === 1) {
          // Simulated transient AWS/network failure — before the fix,
          // this alone would have permanently ended the polling loop.
          throw new Error("simulated transient ReceiveMessage failure");
        }
        if (receiveCallCount === 2) {
          return {
            Messages: [
              { MessageId: "m1", ReceiptHandle: "rh1", Body: JSON.stringify({ ok: true }) },
            ],
          };
        }
        return new Promise((resolve) => setTimeout(() => resolve({ Messages: [] }), 50));
      },
      DeleteMessageCommand: () => ({}),
    });
    const adapter = createSqsQueueAdapter(client);

    const seen: unknown[] = [];
    await adapter.subscribe("q", async (message) => {
      seen.push(message.payload);
    });

    // The adapter's own backoff after a receive failure is ~1s — wait
    // past that so the second (successful) receive call has a chance to
    // run before unsubscribing.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await expect(adapter.unsubscribe("q")).resolves.toBeUndefined();

    expect(receiveCallCount).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual([{ ok: true }]);
  }, 5_000);

  it("N4 real finding (P1): subscribing a second time for the same queue stops the first consumer instead of leaking an orphaned loop", async () => {
    let receiveCallCount = 0;
    const client = fakeClient({
      GetQueueUrlCommand: () => ({ QueueUrl: "https://sqs.example/q" }),
      ReceiveMessageCommand: () => {
        receiveCallCount += 1;
        // A message on every call, forever — if the first loop were
        // still alive after the second subscribe(), it would keep
        // receiving these and calling handler1.
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                Messages: [
                  {
                    MessageId: `m${receiveCallCount}`,
                    ReceiptHandle: `rh${receiveCallCount}`,
                    Body: JSON.stringify({ n: receiveCallCount }),
                  },
                ],
              }),
            10,
          ),
        );
      },
      DeleteMessageCommand: () => ({}),
    });
    const adapter = createSqsQueueAdapter(client);

    const seenByHandler1: unknown[] = [];
    await adapter.subscribe("q", async (message) => {
      seenByHandler1.push(message.payload);
    });
    // Let handler1 genuinely receive at least one message before
    // replacing it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seenByHandler1.length).toBeGreaterThan(0);

    const seenByHandler2: unknown[] = [];
    // The second subscribe() call itself stops-and-awaits the first
    // loop's `done` before returning — a receive+process cycle already
    // IN FLIGHT when stop() is called legitimately finishes (it can't be
    // aborted mid-handler), so handler1's count may still grow by at most
    // one message DURING this call. What matters is that it grows no
    // further AFTER this call resolves — captured below, not before.
    await adapter.subscribe("q", async (message) => {
      seenByHandler2.push(message.payload);
    });
    const handler1CountAfterReplace = seenByHandler1.length;
    // Give handler2 time to genuinely receive messages too.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // handler1 received nothing more once the replacement had fully
    // completed — its loop was actually stopped, not left running in the
    // background.
    expect(seenByHandler1.length).toBe(handler1CountAfterReplace);
    expect(seenByHandler2.length).toBeGreaterThan(0);

    // Only ONE active consumer remains reachable — unsubscribe cleanly
    // stops it with no leaked, unreachable second loop.
    await expect(adapter.unsubscribe("q")).resolves.toBeUndefined();
    const countAfterUnsubscribe = seenByHandler2.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seenByHandler2.length).toBe(countAfterUnsubscribe);
  }, 5_000);
});
