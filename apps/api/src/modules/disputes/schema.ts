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

/**
 * Feature 21 (arbitration-committee), T-2108 (F-2110). A single round of
 * multi-round evidence for an already-open dispute — `content` mirrors
 * `evidenceSummary`'s own bound (10,000 chars).
 */
export const submitDisputeEvidenceSchema = z.object({
  content: z.string().trim().min(1, "请填写举证内容").max(10_000, "举证内容过长"),
});

/**
 * N4 real finding (P2, round 2, T-2108): cursor pagination for
 * `GET /tasks/:taskId/disputes/evidence` — `after` is an opaque
 * `sequence_no` cursor (a real `BIGSERIAL` value as a string, since JS
 * numbers cannot losslessly represent the full `bigint` range), `limit`
 * bounded generously but not unbounded (`listDisputeEvidenceSubmissions`
 * itself clamps to `[1, 200]` regardless, this is just the friendly-400
 * layer for an obviously-wrong value).
 */
export const listDisputeEvidenceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().regex(/^\d+$/, "after 必须是合法的游标").optional(),
});
