import { z } from "zod";

/**
 * `POST /tasks/:taskId/ratings` (F-1005, design.md's interface contract:
 * `score: 1|2|3|4|5`). `communicationScore` (F-1310, Feature 13/T-1306) is
 * optional — a requester who skips it leaves the signal genuinely missing
 * (`ratings.communication_score` stays `NULL`), never a fabricated
 * default; F-1309's own reputation-signals aggregation depends on being
 * able to tell "not submitted" apart from "submitted a low score."
 */
export const submitRatingSchema = z.object({
  score: z.number().int().min(1, "评分需为 1-5").max(5, "评分需为 1-5"),
  communicationScore: z
    .number()
    .int()
    .min(1, "沟通评分需为 1-5")
    .max(5, "沟通评分需为 1-5")
    .optional(),
});

export const taskIdParamSchema = z.object({
  taskId: z.string().uuid(),
});
