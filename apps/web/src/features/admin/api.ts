import { apiFetch } from "../../shared/api/client.js";

/** F-1609 (Feature 16, T-1608b) — mirrors apps/api's admin/dashboard-routes.ts
 * `toAdminAgentJson` projection exactly (a deliberately smaller subset of
 * the full `Agent` shape than agents/api.ts's own `Agent` — the review
 * queue is a scanning list, not a detail view; a click-through still goes
 * to the real `/agents/:agentId` route for the full picture). */
export interface AdminAgentSummary {
  agentId: string;
  ownerAddress: string;
  name: string;
  category: string;
  status: "ACTIVE" | "INACTIVE";
  reviewStatus: "DRAFT" | "PENDING_REVIEW" | "ACTIVE" | "REJECTED" | "SUSPENDED";
  pricingType: "FREE" | "PER_TASK" | "SUBSCRIPTION" | "HOURLY";
  createdAt: string;
}

/** Mirrors admin/dashboard-routes.ts's `toDisputeJson` projection. */
export interface AdminDisputeSummary {
  disputeId: string;
  taskId: string;
  requesterAddress: string;
  reason: string;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
}

/** Mirrors funds/repository.ts's `PlatformFundsSummary` — every amount a
 * decimal string, never `Number()`-coerced (same precision-preserving
 * convention agents/api.ts's `referencePrice` already documents). */
export interface PlatformFundsSummary {
  totalEscrowed: string;
  totalReleased: string;
  totalRefunded: string;
  activeLocked: string;
}

/** Mirrors admin/dashboard.ts's `AdminDashboard.metrics` exactly, including
 * `pendingReviewCount`'s intentional duplication of `reviewQueue.total`
 * (see that file's own doc comment for why: one `metrics` object for every
 * F-1610 "运行指标", rather than making a frontend reach into a differently-
 * shaped object for one of the four numbers). */
export interface AdminDashboardMetrics {
  windowDays: number;
  tasksPublishedInWindow: number;
  tasksCompletedInWindow: number;
  disputesInWindow: number;
  pendingReviewCount: number;
}

export interface AdminDashboard {
  publishedTaskCount: number;
  publishedAgentCount: number;
  reviewQueue: { items: AdminAgentSummary[]; total: number };
  openDisputes: AdminDisputeSummary[];
  platformFunds: PlatformFundsSummary;
  metrics: AdminDashboardMetrics;
}

/** `GET /admin/dashboard` — admin-only server-side (`app.requireAdmin`);
 * this call throws `ApiError` with `status === 403` for any signed-in
 * non-admin caller. There is no client-side "am I admin" check anywhere in
 * this module — the server's response is the only authority (requirements.md's
 * "不能是知道某个 URL 就能访问"), `AdminDashboardPage` renders its
 * "无权限" state purely off that 403. */
export function getAdminDashboard(): Promise<AdminDashboard> {
  return apiFetch<AdminDashboard>("/admin/dashboard");
}
