import { apiFetch, ApiError } from "../../shared/api/client.js";

export interface SubmitRatingResult {
  ratingId: string;
}

export function submitRating(
  taskId: string,
  score: 1 | 2 | 3 | 4 | 5,
): Promise<SubmitRatingResult> {
  return apiFetch<SubmitRatingResult>(`/tasks/${taskId}/ratings`, {
    method: "POST",
    body: JSON.stringify({ score }),
  });
}

export interface RatingRecord {
  ratingId: string;
  score: number;
  createdAt: string;
}

/** A 404 ("该任务尚无评分记录") is the routine "not yet rated" case —
 * surfaced as a thrown `ApiError`, same as `deliverables/api.ts`'s
 * `getLatestDeliverable` and `disputes/api.ts`'s `getDispute`;
 * `RatingSection` is what interprets that specifically rather than
 * treating it as a load failure. */
export function getRating(taskId: string): Promise<RatingRecord> {
  return apiFetch<RatingRecord>(`/tasks/${taskId}/ratings`);
}

export { ApiError };
