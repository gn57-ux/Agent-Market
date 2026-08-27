import { z } from "zod";

/**
 * `POST /tasks/:taskId/disputes` (F-1003, design.md's interface
 * contract). `reason` is a short, structured complaint category/summary;
 * `evidenceSummary` is the full-text evidence this backend hashes
 * (`evidence-hash.ts`) — both bounded generously but not unbounded, same
 * "friendly 400 instead of a raw DB error" reasoning as every other
 * schema in this codebase.
 */
export const submitDisputeSchema = z.object({
  reason: z.string().trim().min(1, "请填写争议原因").max(500, "争议原因过长"),
  evidenceSummary: z.string().trim().min(1, "请填写证据说明").max(10_000, "证据说明过长"),
});

export const taskIdParamSchema = z.object({
  taskId: z.string().uuid(),
});
