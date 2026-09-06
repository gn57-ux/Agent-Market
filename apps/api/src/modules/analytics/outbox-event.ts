import type { PoolClient } from "pg";
import type { Queryable } from "../../db/pool.js";
import { writeOutboxEvent, type WriteOutboxEventInput } from "../outbox/repository.js";
import { insertInteractionEvent, type InsertInteractionEventInput } from "./repository.js";

/**
 * F-1901 (T-1901): the 7 server-originated event types (EXPOSURE/ACCEPT/
 * SUBMIT/APPROVE/RATE/REFUND/DISPUTE) are written to `outbox_events`
 * (Feature 18) inside the SAME transaction as their real business write —
 * design.md's own interface contract, verbatim. This file is the one place
 * that knows both directions of that mapping (CLAUDE.md 原则 6: 设计知识只能
 * 有一个归属) — `buildInteractionEventOutboxInput` (write side, called from
 * each business endpoint) and `applyInteractionEventOutboxPayload`
 * (consume side, called once an outbox row is actually relayed) are kept
 * together so a future field added to one is never forgotten in the other.
 *
 * `session_id` real gap (found while implementing this Task): none of the
 * 7 server-side business endpoints have any concept of a client browsing
 * session id — that only exists for the frontend-reported VIEW/CLICK path
 * (`POST /analytics/events`). `interaction_events.session_id` is `NOT
 * NULL` (T-1900, already reviewed and merged) and F-1904's session
 * correlation is meaningful for browsing-behavior events, not for a
 * wallet-signed/chain-confirmed business action that already carries a
 * more precise correlation key (`task_id`). Rather than reopening T-1900's
 * already-shipped schema to relax that constraint for a gap only
 * discovered one Task later, server-originated events get a deterministic,
 * clearly-namespaced placeholder (`server:<taskId>`) that can never
 * collide with a real frontend-generated session id and needs no special
 * NULL-handling in any downstream consumer (T-1902's attribution window,
 * T-1904's dataset builder).
 */
export const SERVER_SESSION_ID_PREFIX = "server:";

export function serverSessionId(taskId: string): string {
  return `${SERVER_SESSION_ID_PREFIX}${taskId}`;
}

export const INTERACTION_EVENT_OUTBOX_KIND = "interaction_event";

export interface InteractionEventOutboxPayload extends InsertInteractionEventInput {
  kind: typeof INTERACTION_EVENT_OUTBOX_KIND;
}

/**
 * `aggregateType`/`aggregateId` convention (first real callers of
 * `writeOutboxEvent` outside Feature 18's own tests — no prior convention
 * to match): `"task"`/`taskId`, since every one of the 7 server-originated
 * event types carries a real `taskId` and that is each row's natural join
 * key back to the business entity that produced it.
 */
export function buildInteractionEventOutboxInput(
  input: InsertInteractionEventInput & { taskId: string },
): WriteOutboxEventInput {
  const payload: InteractionEventOutboxPayload = {
    kind: INTERACTION_EVENT_OUTBOX_KIND,
    ...input,
  };
  return {
    aggregateType: "task",
    aggregateId: input.taskId,
    eventType: input.eventType,
    payload,
  };
}

export async function writeInteractionEventToOutbox(
  client: PoolClient,
  input: InsertInteractionEventInput & { taskId: string },
): Promise<void> {
  await writeOutboxEvent(client, buildInteractionEventOutboxInput(input));
}

/** T-1900's own closed `event_type` CHECK enum — re-declared here (the
 * consume-side boundary) rather than imported from a migration file, same
 * reasoning as `attribution.ts`'s own copy: this is the one list every
 * payload-shape validator in this codebase that touches
 * `interaction_events` needs, so each boundary keeps a plain literal
 * rather than parsing SQL at runtime. */
const REAL_EVENT_TYPES = new Set([
  "EXPOSURE",
  "VIEW",
  "CLICK",
  "ACCEPT",
  "SUBMIT",
  "APPROVE",
  "RATE",
  "REFUND",
  "DISPUTE",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOptionalUuid(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && UUID_PATTERN.test(value));
}

/**
 * N4 real finding (P2, T-1902 round 1): the original version only checked
 * the 3 required string fields, then narrowed the WHOLE object (including
 * the optional `taskId`/`agentId`/`runId` UUID fields) to
 * `InteractionEventOutboxPayload` — a payload with `taskId: 123`, a
 * non-UUID string, or an unsupported `eventType` (e.g. from a future
 * version skew between a relay and this consumer) would pass this guard
 * and only fail later at the `INSERT` itself, which `withIdempotentConsumption`
 * (packages/queue) reports as a handler failure to be retried, not as "not
 * my message" — the exact same malformed message would then retry forever
 * instead of the shared-queue contract's documented "return false, apply
 * nothing" for a message this consumer doesn't recognize. Fixed by
 * validating `eventType` against the real closed enum and every optional
 * id field's shape before returning `true`.
 *
 * N4 real finding (P2, T-1902 round 2 — mirrored in `apps/worker`'s own
 * copy, see that file's doc comment for the full reasoning): a shape-valid
 * but semantically-empty `EXPOSURE` (no `taskId`/`agentId`/`runId` — all
 * nullable at the DB layer) would still insert cleanly and then be
 * permanently useless to `attribution.ts`'s `findAttributedOutcomes`,
 * which needs a real `task_id` to look up anything. Each event type's own
 * real minimum shape (matching what its 7 real write-side call sites
 * always actually supply) is now enforced here too.
 */
const REQUIRED_FIELDS_BY_EVENT_TYPE: Record<string, Array<keyof InsertInteractionEventInput>> = {
  EXPOSURE: ["taskId", "agentId", "runId"],
  ACCEPT: ["taskId", "agentId"],
  SUBMIT: ["taskId"],
  APPROVE: ["taskId"],
  RATE: ["taskId", "agentId"],
  REFUND: ["taskId"],
  DISPUTE: ["taskId"],
};

function isInteractionEventOutboxPayload(
  payload: unknown,
): payload is InteractionEventOutboxPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    candidate.kind !== INTERACTION_EVENT_OUTBOX_KIND ||
    typeof candidate.eventType !== "string" ||
    !REAL_EVENT_TYPES.has(candidate.eventType) ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.clientEventId !== "string" ||
    !isOptionalUuid(candidate.taskId) ||
    !isOptionalUuid(candidate.agentId) ||
    !isOptionalUuid(candidate.runId) ||
    (candidate.actorAddress !== undefined && typeof candidate.actorAddress !== "string")
  ) {
    return false;
  }
  const requiredFields = REQUIRED_FIELDS_BY_EVENT_TYPE[candidate.eventType] ?? [];
  return requiredFields.every((field) => typeof candidate[field] === "string");
}

/**
 * The consume side — applies one relayed `outbox_events.payload` to
 * `interaction_events`. Real caller: `apps/worker`'s subscriber routes an
 * incoming message here whenever its payload is shaped like an interaction
 * event (see that process's own doc comment for why apps/worker can't
 * import this module directly — a separate deployable, not a dependency
 * on apps/api's module tree — and instead carries its own equivalent
 * routing check against the same `kind` discriminant).
 *
 * Returns `false` (and applies nothing) for a payload that isn't shaped
 * like an interaction event, so a shared queue that one day carries other
 * message kinds doesn't need this function to guess or throw.
 */
export async function applyInteractionEventOutboxPayload(
  client: Queryable,
  payload: unknown,
): Promise<boolean> {
  if (!isInteractionEventOutboxPayload(payload)) {
    return false;
  }
  await insertInteractionEvent(client, payload);
  return true;
}
