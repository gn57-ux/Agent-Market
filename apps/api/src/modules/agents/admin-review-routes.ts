import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AgentRow } from "./repository.js";
import { approveAgent, listReviewQueue, rejectAgent, suspendAgent } from "./review.js";
import {
  agentIdParamSchema,
  rejectAgentReviewSchema,
  reviewQueueQuerySchema,
  suspendAgentReviewSchema,
} from "./schema.js";
import { formatZodError } from "../../shared/zod-error.js";

/** Same summary projection `agents/routes.ts`'s `toAgentSummaryJson` uses
 * for an owner-viewing-their-own-Agent response — an admin sees exactly
 * that shape (including `credentialRef`, which is otherwise owner-only):
 * an admin reviewing an Agent legitimately needs the full picture, same as
 * the Agent's own owner would. Not imported from routes.ts (that function
 * isn't exported, and duplicating this one small object-literal projection
 * is simpler than exporting a helper across an owner/admin boundary for a
 * single caller). */
function toAdminAgentJson(agent: AgentRow) {
  return {
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    name: agent.name,
    description: agent.description,
    category: agent.category,
    skillTags: agent.skillTags,
    authorBio: agent.authorBio,
    invocationUrl: agent.invocationUrl,
    payoutAddress: agent.payoutAddress,
    pricingModel: agent.pricingModel,
    referencePrice: agent.referencePrice,
    protocolVersion: agent.protocolVersion,
    credentialRef: agent.credentialRef,
    status: agent.status,
    reviewStatus: agent.reviewStatus,
    pricingType: agent.pricingType,
    completedTaskCount: agent.completedTaskCount,
    successCount: agent.successCount,
    overdueCount: agent.overdueCount,
    qualityScore: agent.qualityScore,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

/**
 * F-1605/F-1606 (T-1605): the admin-facing half of the Agent review
 * lifecycle — `GET /admin/agents/review-queue`, `POST
 * /admin/agents/:agentId/approve`, `.../reject`, `.../suspend`. Every route
 * here is gated by `app.requireAdmin`, never `app.requireSession` alone —
 * a deliberate SEPARATE file from `agents/routes.ts` (which is exclusively
 * public/owner-gated) so a route's file location alone signals which
 * authorization it carries, rather than every route needing its own
 * explicit review to confirm a shared file didn't mix the two.
 */
export function registerAdminAgentReviewRoutes(app: FastifyInstance, pool: Pool): void {
  app.get(
    "/admin/agents/review-queue",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const parsed = reviewQueueQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
      }
      const { items, total } = await listReviewQueue(pool, parsed.data.page, parsed.data.pageSize);
      return reply.send({
        items: items.map(toAdminAgentJson),
        total,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      });
    },
  );

  app.post(
    "/admin/agents/:agentId/approve",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      // request.address is guaranteed set by app.requireAdmin (same
      // contract as app.requireSession — middleware.ts's doc comment).
      const adminAddress = request.address;
      if (!adminAddress) {
        return reply.status(401).send({
          error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
        });
      }

      const result = await approveAgent(pool, adminAddress, paramsParsed.data.agentId);
      if (!result.ok) {
        if (result.reason === "not_found") {
          return reply.status(404).send({ error: { message: "未找到该 Agent。" } });
        }
        return reply.status(409).send({
          error: { message: "该 Agent 当前状态不是待审核，无法通过审核。" },
        });
      }
      return reply.send(toAdminAgentJson(result.agent));
    },
  );

  app.post(
    "/admin/agents/:agentId/reject",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = rejectAgentReviewSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const adminAddress = request.address;
      if (!adminAddress) {
        return reply.status(401).send({
          error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
        });
      }

      const result = await rejectAgent(
        pool,
        adminAddress,
        paramsParsed.data.agentId,
        bodyParsed.data.reason,
      );
      if (!result.ok) {
        if (result.reason === "not_found") {
          return reply.status(404).send({ error: { message: "未找到该 Agent。" } });
        }
        return reply.status(409).send({
          error: { message: "该 Agent 当前状态不是待审核，无法拒绝。" },
        });
      }
      return reply.send(toAdminAgentJson(result.agent));
    },
  );

  app.post(
    "/admin/agents/:agentId/suspend",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = suspendAgentReviewSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const adminAddress = request.address;
      if (!adminAddress) {
        return reply.status(401).send({
          error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
        });
      }

      const result = await suspendAgent(
        pool,
        adminAddress,
        paramsParsed.data.agentId,
        bodyParsed.data.reason,
      );
      if (!result.ok) {
        if (result.reason === "not_found") {
          return reply.status(404).send({ error: { message: "未找到该 Agent。" } });
        }
        return reply.status(409).send({
          error: { message: "该 Agent 当前状态不是启用中，无法停用。" },
        });
      }
      return reply.send(toAdminAgentJson(result.agent));
    },
  );
}
