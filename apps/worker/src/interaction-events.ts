import type { PoolClient } from "pg";

/**
 * F-1901 (T-1901): the real business handler `apps/worker`'s subscriber was
 * always built to eventually get (see `main.ts`'s own doc comment on the
 * placeholder this replaces) — every message this queue carries whose
 * payload is shaped like an interaction event gets applied to
 * `interaction_events` here.
 *
 * This insert intentionally duplicates `apps/api/src/modules/analytics/
 * repository.ts`'s `insertInteractionEvent` (same columns, same `ON
 * CONFLICT (client_event_id) DO NOTHING` dedup) rather than importing it —
 * `apps/worker` is a separate deployable from `apps/api` (its own
 * `package.json`, its own deploy unit), and this monorepo's own established
 * convention is that apps depend on `packages/*`, never on each other's
 * internals. One ~15-line SQL statement, kept in sync by inspection (same
 * cost as any other cross-cutting one-liner in this codebase), is cheaper
 * and clearer than inventing a new shared package for a single INSERT.
 */
export const INTERACTION_EVENT_OUTBOX_KIND = "interaction_event";

export interface InteractionEventPayload {
  kind: typeof INTERACTION_EVENT_OUTBOX_KIND;
  eventType: string;
  sessionId: string;
  clientEventId: string;
  taskId?: string;
  agentId?: string;
  runId?: string;
  actorAddress?: string;
}

/** T-1900's own closed `event_type` CHECK enum. */
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
 * N4 real finding (P2, T-1902 round 1 — same fix mirrored from `apps/api`'s
 * own `outbox-event.ts`, see that file's doc comment for the full
 * reasoning): validating only the 3 required strings let a malformed or
 * version-skewed payload (bad `eventType`, non-UUID id field) pass this
 * guard and fail later at the real `INSERT`, which `withIdempotentConsumption`
 * treats as a retryable handler failure rather than "not my message" —
 * retrying forever instead of returning `false` as this consumer's own
 * contract promises for an unrecognized payload shape.
 *
 * N4 real finding (P2, T-1902 round 2): the round-1 fix validated each
 * optional id's SHAPE but not whether a given `eventType` actually needs
 * one — `interaction_events`'s own columns are nullable at the DB layer
 * (so a `taskId`/`agentId`/`runId`-less `EXPOSURE` would insert cleanly),
 * but such a row is permanently useless: `findAttributedOutcomes`
 * (`apps/api`'s `attribution.ts`) requires a real `task_id` to look up
 * anything at all, and this message would already be marked processed by
 * the time anyone notices. `REQUIRED_FIELDS_BY_EVENT_TYPE` enforces each
 * event type's own real minimum shape (see `writeInteractionEventToOutbox`'s
 * 7 real call sites, `apps/api`'s `outbox-event.ts` write side, for what
 * each type always actually carries) before accepting the message —
 * failing this check returns `false` (not-my-message) rather than
 * silently swallowing an incomplete row.
 */
const REQUIRED_FIELDS_BY_EVENT_TYPE: Record<string, Array<"taskId" | "agentId" | "runId">> = {
  EXPOSURE: ["taskId", "agentId", "runId"],
  ACCEPT: ["taskId", "agentId"],
  SUBMIT: ["taskId"],
  APPROVE: ["taskId"],
  RATE: ["taskId", "agentId"],
  REFUND: ["taskId"],
  DISPUTE: ["taskId"],
};

export function isInteractionEventPayload(payload: unknown): payload is InteractionEventPayload {
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
 * N4 round 2 (T-1902) re-flagged the same `ON CONFLICT (client_event_id) DO
 * NOTHING` collision T-1901 round 2 already found and fixed — reviewed
 * this time from this INSERT's own vantage point rather than the anonymous
 * endpoint's, without visibility into the fix (outside this Task's scoped
 * diff). Confirmed still closed: `apps/api/src/modules/analytics/routes.ts`
 * (`registerAnalyticsRoutes`) unconditionally prefixes EVERY client-
 * reported `clientEventId` with `"client:"` before it ever reaches
 * `interaction_events` — a client cannot choose to skip that prefix, so a
 * submission like `clientEventId: "accept:<taskId>"` is stored as
 * `"client:accept:<taskId>"`, which can never collide with this function's
 * own unprefixed, server-generated ids (`"accept:<taskId>"`, etc. — see
 * `apps/api`'s `outbox-event.ts` write-side call sites). See
 * `routes.integration.test.ts`'s own "N4 P1 fix" test for the end-to-end
 * proof at that boundary.
 */
export async function applyInteractionEvent(
  client: PoolClient,
  payload: InteractionEventPayload,
): Promise<void> {
  await client.query(
    `INSERT INTO interaction_events
       (event_type, session_id, client_event_id, task_id, agent_id, run_id, actor_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (client_event_id) DO NOTHING`,
    [
      payload.eventType,
      payload.sessionId,
      payload.clientEventId,
      payload.taskId ?? null,
      payload.agentId ?? null,
      payload.runId ?? null,
      payload.actorAddress ?? null,
    ],
  );
}
