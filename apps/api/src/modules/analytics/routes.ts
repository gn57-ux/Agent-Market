import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { SESSION_COOKIE_NAME } from "../auth/session.middleware.js";
import { verifySession } from "../auth/session.service.js";
import { checkIdentifierAssociation, insertInteractionEvent } from "./repository.js";
import { reportAnalyticsEventSchema } from "./schema.js";

/**
 * N4 real finding (P1, T-1901 round 2): every server-originated event
 * writes a predictable `clientEventId` (e.g. `accept:<taskId>`,
 * `exposure:<runId>:<agentId>` — see `outbox-event.ts`) into the SAME
 * `interaction_events.client_event_id` column this anonymous, unauthenticated
 * endpoint also writes into. Without this prefix, an attacker who knows a
 * taskId (public — task listings are public) could pre-submit a VIEW with
 * `clientEventId: "accept:<taskId>"` before the real acceptance ever
 * happens; when the real ACCEPT event later hits the SAME dedup key,
 * `ON CONFLICT DO NOTHING` would silently drop the real business event,
 * permanently deleting it from the analytics record. Prefixing every
 * client-reported id with a namespace no server-generated id ever uses
 * makes a collision structurally impossible, regardless of what string the
 * client sends and regardless of what new server-side prefixes future
 * Tasks add (a blocklist of today's known prefixes would not have covered
 * that).
 */
const CLIENT_REPORTED_EVENT_ID_PREFIX = "client:";

/** Same pattern as `agents/routes.ts`'s own copy of this helper — a
 * best-effort ("don't 401, just tell me if there's a valid session") read,
 * deliberately re-declared per module rather than shared. `POST
 * /analytics/events` must stay reachable by an anonymous browsing session
 * (VIEW/CLICK happen before a user ever connects a wallet), so it does not
 * use `app.requireSession` as a preHandler — a present, valid session only
 * *enriches* the event with `actor_address`; its absence is not an error. */
async function getOptionalSessionAddress(
  request: FastifyRequest,
  pool: Pool,
): Promise<string | undefined> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return undefined;
  }
  const verified = await verifySession(pool, token);
  return verified?.address;
}

/**
 * F-1901/F-1902 (T-1901): `POST /analytics/events` — the only HTTP entry
 * point for the 2 event types (VIEW/CLICK) design.md's interface contract
 * names as unable to arise naturally on the backend. Writes directly to
 * `interaction_events` (see `repository.ts`'s own doc comment for why no
 * outbox indirection is needed here) using `client_event_id`'s `ON CONFLICT
 * DO NOTHING` — a frontend retrying the same report after a flaky network
 * response is a safe no-op (AC-1902), and this endpoint always returns 204
 * once the row exists (new or already-deduped), never surfacing the
 * difference to the caller.
 *
 * design.md's own security/兼容性 note: "事件采集失败...不得阻塞任何业务主
 * 流程" — this endpoint has no other business logic to block, so a genuine
 * DB failure here simply surfaces as a 500 to the (fire-and-forget)
 * frontend caller, same as any other write endpoint; there is nothing else
 * in this request whose correctness depends on this insert succeeding.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/analytics/events", async (request, reply) => {
    const parsed = reportAnalyticsEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }

    // N4 real finding (P2, T-1901 round 1, widened round 2): reject any
    // taskId/agentId/runId combination that isn't a genuine association —
    // see repository.ts's own doc comment for the full rule set.
    const association = await checkIdentifierAssociation(pool, {
      taskId: parsed.data.taskId,
      agentId: parsed.data.agentId,
      runId: parsed.data.runId,
    });
    if (!association.ok) {
      return reply.status(400).send({
        error: { message: "taskId/agentId/runId 与真实撮合候选不匹配。" },
      });
    }

    const actorAddress = await getOptionalSessionAddress(request, pool);

    await insertInteractionEvent(pool, {
      eventType: parsed.data.eventType,
      sessionId: parsed.data.sessionId,
      clientEventId: CLIENT_REPORTED_EVENT_ID_PREFIX + parsed.data.clientEventId,
      taskId: parsed.data.taskId,
      agentId: parsed.data.agentId,
      runId: parsed.data.runId,
      actorAddress,
    });

    return reply.status(204).send();
  });
}
