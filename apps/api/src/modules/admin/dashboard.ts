import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { listOpenDisputes, type DisputeRow } from "../disputes/repository.js";
import { getPlatformFundsSummary, type PlatformFundsSummary } from "../funds/repository.js";
import { listAgents } from "../agents/repository.js";
import { listTasks } from "../tasks/repository.js";
import { listReviewQueue } from "../agents/review.js";
import type { AgentRow } from "../agents/repository.js";

/**
 * F-1609/F-1610 (Feature 16, T-1608b) — `GET /admin/dashboard`'s
 * aggregation. Deliberately composes ALREADY-EXISTING, independently
 * tested queries from their owning modules (`listReviewQueue` (T-1605),
 * `listOpenDisputes` (disputes module), `getPlatformFundsSummary`
 * (T-1608), `listTasks`/`listAgents` (Feature 6/5)) rather than
 * reimplementing any of their filtering rules here — this Task's own
 * description explicitly requires reuse ("复用 T-1605 审核队列查询与既有
 * disputes 模块，不重复实现"), and CLAUDE.md 原则 6 makes that a general rule,
 * not a one-off instruction: "已发布 Agent" and "已发布任务" are each already a
 * single-owned business rule (`AgentRow.reviewStatus === 'ACTIVE' &&
 * AgentRow.status === 'ACTIVE'` — the two columns are orthogonal per
 * design.md 决策 3, and an approved-but-owner-deactivated Agent is not
 * actually market-visible, Codex review T-1608b round 1 P2 / task's own
 * `PUBLIC_MARKET_STATUSES`) that this module must not re-derive.
 *
 * F-1610's "近 N 天" window: N = 7 (design.md's own rationale section
 * explains this choice — requirements.md explicitly requires a documented
 * reason, not an arbitrary pick). `RUN_WINDOW_DAYS` is exported so the
 * integration test can assert against the exact same value this module
 * actually uses, rather than a hardcoded duplicate that could silently
 * drift from it.
 */
export const DASHBOARD_METRICS_WINDOW_DAYS = 7;

/** Bounds the Dashboard's disputes list — a summary view, not a paginated
 * browser (see `listOpenDisputes`'s own doc comment, disputes/repository.ts). */
const OPEN_DISPUTES_LIMIT = 50;

export interface AdminDashboard {
  publishedTaskCount: number;
  publishedAgentCount: number;
  reviewQueue: { items: AgentRow[]; total: number };
  openDisputes: DisputeRow[];
  platformFunds: PlatformFundsSummary;
  metrics: {
    windowDays: number;
    tasksPublishedInWindow: number;
    tasksCompletedInWindow: number;
    disputesInWindow: number;
    /** Same value as `reviewQueue.total` above — intentionally mirrored
     * here (not an independently-computed number that could drift from
     * it) so every F-1610 "运行指标" lives together under one `metrics`
     * object for a frontend rendering that section, without also having to
     * reach into `reviewQueue` for this one number. */
    pendingReviewCount: number;
  };
}

async function getWindowedTaskCounts(
  pool: Queryable,
  windowDays: number,
): Promise<{ tasksPublishedInWindow: number; tasksCompletedInWindow: number }> {
  const { rows } = await pool.query<{ published: string; completed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE to_status = 'OPEN' AND occurred_at >= now() - make_interval(days => $1)) AS published,
       COUNT(*) FILTER (WHERE to_status = 'RELEASED' AND occurred_at >= now() - make_interval(days => $1)) AS completed
     FROM task_state_history`,
    [windowDays],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("getWindowedTaskCounts: aggregate query produced no row");
  }
  return {
    tasksPublishedInWindow: Number(row.published),
    tasksCompletedInWindow: Number(row.completed),
  };
}

async function getWindowedDisputeCount(pool: Queryable, windowDays: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM disputes WHERE created_at >= now() - make_interval(days => $1)`,
    [windowDays],
  );
  return Number(rows[0]?.count ?? "0");
}

export async function getAdminDashboard(pool: Pool): Promise<AdminDashboard> {
  const [
    publishedTasks,
    publishedAgents,
    reviewQueue,
    openDisputes,
    platformFunds,
    windowedTaskCounts,
    disputesInWindow,
  ] = await Promise.all([
    listTasks(pool, { page: 1, pageSize: 1, restrictToPublicStatuses: true }),
    // Codex review (T-1608b round 1 P2): `status` (owner's own on/off
    // market toggle) and `reviewStatus` (platform review lifecycle) are
    // orthogonal columns (design.md 决策 3) — an approved Agent the owner
    // has since deactivated (`status: "INACTIVE"`) is NOT actually visible
    // in the market, so "已发布 Agent 数" must require BOTH, matching what
    // a real market visitor's default view (AgentMarketPage's own
    // status=ACTIVE default) actually shows.
    listAgents(pool, { reviewStatus: "ACTIVE", status: "ACTIVE", page: 1, pageSize: 1 }),
    listReviewQueue(pool, 1, 50),
    listOpenDisputes(pool, OPEN_DISPUTES_LIMIT),
    getPlatformFundsSummary(pool),
    getWindowedTaskCounts(pool, DASHBOARD_METRICS_WINDOW_DAYS),
    getWindowedDisputeCount(pool, DASHBOARD_METRICS_WINDOW_DAYS),
  ]);

  return {
    publishedTaskCount: publishedTasks.total,
    publishedAgentCount: publishedAgents.total,
    reviewQueue: { items: reviewQueue.items, total: reviewQueue.total },
    openDisputes,
    platformFunds,
    metrics: {
      windowDays: DASHBOARD_METRICS_WINDOW_DAYS,
      ...windowedTaskCounts,
      disputesInWindow,
      pendingReviewCount: reviewQueue.total,
    },
  };
}
