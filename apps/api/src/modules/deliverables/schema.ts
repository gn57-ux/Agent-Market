import { z } from "zod";

/**
 * `POST /tasks/:taskId/deliverables`'s URL-input path (F-901/F-907) — the
 * JSON-body shape when the caller submits `{ resultUrl }` instead of a
 * multipart file. The `https`-only rule is defined here AND at the
 * database layer (0009_create_deliverables.sql's
 * `deliverables_result_url_is_https` CHECK) — same "app-layer validation
 * paired with a DB constraint of last resort" pattern this codebase
 * already uses elsewhere (e.g. tasks/schema.ts's address-format checks);
 * this schema exists so a bad URL gets a friendly 400 instead of a raw
 * constraint-violation error surfacing from the database.
 */
export const submitDeliverableUrlSchema = z.object({
  resultUrl: z
    .string()
    .trim()
    .max(2048, "URL 过长")
    .url("必须是合法的 URL")
    .refine((value) => value.startsWith("https://"), "URL 类型成果仅允许 https 协议"),
});

export const taskIdParamSchema = z.object({
  taskId: z.string().uuid(),
});
