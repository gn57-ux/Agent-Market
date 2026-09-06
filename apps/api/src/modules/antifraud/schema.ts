import { z } from "zod";

/**
 * F-2010/T-2008: `GET /admin/risk-signals`'s query — `status` narrows to
 * one lifecycle stage (omitted means "everything"); `page`/`pageSize`
 * match this codebase's own established pagination convention
 * (`tasks/schema.ts`'s `listTasksQuerySchema`, `agents/schema.ts`'s
 * listing schemas — same bounds, same `z.coerce.number()` for query-string
 * numbers). N4 real finding (P2): an earlier version had no pagination at
 * all — `risk_signals` is continuously appended to by periodic detector
 * runs and old resolved rows are never deleted, so an unbounded `SELECT *`
 * would eventually return unbounded rows/`evidence` JSONB and risk request
 * timeouts or memory pressure as the table grows.
 */
export const listRiskSignalsQuerySchema = z.object({
  status: z.enum(["DETECTED", "UNDER_REVIEW", "CONFIRMED", "DISMISSED"]).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20),
});

export const riskSignalParamsSchema = z.object({ id: z.string().uuid() });
