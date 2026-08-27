import { z } from "zod";

/**
 * `POST /tasks/:taskId/ratings` (F-1005, design.md's interface contract:
 * `score: 1|2|3|4|5`).
 */
export const submitRatingSchema = z.object({
  score: z.number().int().min(1, "评分需为 1-5").max(5, "评分需为 1-5"),
});

export const taskIdParamSchema = z.object({
  taskId: z.string().uuid(),
});
