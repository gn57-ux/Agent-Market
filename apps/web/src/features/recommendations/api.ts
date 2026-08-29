import { apiFetch, ApiError } from "../../shared/api/client.js";

/** Mirrors `GET /tasks/:taskId/recommendations`'s response shape
 * (apps/api/src/modules/dispatch/routes.ts, T-706) — `reasons` is already
 * Chinese explanation text produced by the Go dispatch service's `explain`
 * package, not raw reason codes this module needs to translate. */
export interface RecommendationCandidate {
  agentId: string;
  rank: number;
  slotType: "TOP_SCORE" | "EXPLORATION";
  score: number;
  reasons: string[];
}

export interface RecommendationsResult {
  recommendations: RecommendationCandidate[];
}

export interface MatchResult {
  taskId: string;
  algorithmVersion: string;
  recommendationCount: number;
}

/** Starts the existing requester-authorized V0 matching round. */
export function requestMatch(taskId: string): Promise<MatchResult> {
  return apiFetch<MatchResult>(`/tasks/${taskId}/match`, { method: "POST" });
}

/**
 * Public endpoint — no session required (same as `getTask`'s own
 * public-read reasoning), matching apps/api's `GET /tasks/:taskId/recommendations`
 * being registered with no `requireSession` preHandler.
 */
export function getRecommendations(taskId: string): Promise<RecommendationsResult> {
  return apiFetch<RecommendationsResult>(`/tasks/${taskId}/recommendations`);
}

export { ApiError };
