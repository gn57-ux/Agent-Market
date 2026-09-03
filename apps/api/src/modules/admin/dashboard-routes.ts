import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AgentRow } from "../agents/repository.js";
import type { DisputeRow } from "../disputes/repository.js";
import { getAdminDashboard } from "./dashboard.js";

/** Same summary projection admin/dashboard-routes.ts's sibling
 * (agents/admin-review-routes.ts's `toAdminAgentJson`) uses — an admin
 * reviewing the queue from the Dashboard needs the same full picture.
 * Duplicated rather than imported: importing across these two admin-facing
 * route files for one small object-literal projection would create a
 * dependency between two otherwise-independent route registrations for no
 * real reuse benefit (same reasoning as that function's own doc comment). */
function toAdminAgentJson(agent: AgentRow) {
  return {
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    name: agent.name,
    category: agent.category,
    status: agent.status,
    reviewStatus: agent.reviewStatus,
    pricingType: agent.pricingType,
    createdAt: agent.createdAt.toISOString(),
  };
}

function toDisputeJson(dispute: DisputeRow) {
  return {
    disputeId: dispute.id,
    taskId: dispute.taskId,
    requesterAddress: dispute.requesterAddress,
    reason: dispute.reason,
    status: dispute.status,
    createdAt: dispute.createdAt.toISOString(),
  };
}

/**
 * F-1609/F-1610 (T-1608b): `GET /admin/dashboard`, admin-only. A single
 * read-only aggregation endpoint — see dashboard.ts's own doc comment for
 * why every number here is composed from an already-owned query rather
 * than reimplemented.
 */
export function registerAdminDashboardRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/admin/dashboard", { preHandler: app.requireAdmin }, async (_request, reply) => {
    const dashboard = await getAdminDashboard(pool);
    return reply.send({
      publishedTaskCount: dashboard.publishedTaskCount,
      publishedAgentCount: dashboard.publishedAgentCount,
      reviewQueue: {
        items: dashboard.reviewQueue.items.map(toAdminAgentJson),
        total: dashboard.reviewQueue.total,
      },
      openDisputes: dashboard.openDisputes.map(toDisputeJson),
      platformFunds: dashboard.platformFunds,
      metrics: dashboard.metrics,
    });
  });
}
