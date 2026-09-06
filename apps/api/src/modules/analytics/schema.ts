import { z } from "zod";

/**
 * F-1901/F-1902 (T-1901): `POST /analytics/events` only ever carries the two
 * event types design.md's own interface contract names as "无法在后端自然产生
 * 的事件" — VIEW/CLICK. The other 7 real event types (EXPOSURE/ACCEPT/SUBMIT/
 * APPROVE/RATE/REFUND/DISPUTE) are written server-side, inside the existing
 * business endpoint's own transaction (see each module's own outbox-write
 * call) — a client posting one of those 7 values here would be forging an
 * event it never actually performed, so this schema closes the enum to only
 * the two legitimately client-reported types, not the full 9-value database
 * CHECK constraint.
 */
export const analyticsEventTypeSchema = z.enum(["VIEW", "CLICK"]);

export const reportAnalyticsEventSchema = z.object({
  eventType: analyticsEventTypeSchema,
  sessionId: z.string().min(1, "sessionId 不能为空"),
  clientEventId: z.string().min(1, "clientEventId 不能为空"),
  taskId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
});
