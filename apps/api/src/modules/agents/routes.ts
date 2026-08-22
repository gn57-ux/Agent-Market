import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AgentRow } from "./repository.js";
import { createAgent, getAgentDetail, listAgentsForMarket } from "./service.js";
import { agentIdParamSchema, createAgentSchema, listAgentsQuerySchema } from "./schema.js";

/** Shared response shape for both the list and detail endpoints (F-502).
 * `referencePrice` comes back from `pg` as a string (NUMERIC columns aren't
 * safely representable as JS `number`) — passed through as-is rather than
 * `Number()`-coerced, so a caller doesn't silently lose precision. */
function toAgentSummaryJson(agent: AgentRow) {
  return {
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    name: agent.name,
    description: agent.description,
    category: agent.category,
    skillTags: agent.skillTags,
    authorBio: agent.authorBio,
    invocationUrl: agent.invocationUrl,
    pricingModel: agent.pricingModel,
    referencePrice: agent.referencePrice,
    status: agent.status,
    completedTaskCount: agent.completedTaskCount,
    successCount: agent.successCount,
    overdueCount: agent.overdueCount,
    qualityScore: agent.qualityScore,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

/**
 * Registers the full F-501/F-502 Agent route surface. Wrapped in its own
 * `app.register(...)` at the call site (see app.ts), not called directly
 * after `buildApp()` returns: `POST /agents` uses `app.requireSession` as a
 * preHandler, and that decorator is only guaranteed to exist once
 * `registerSessionMiddleware`'s own registration has finished — see
 * session.middleware.ts's doc comment. `GET /agents` and `GET
 * /agents/:agentId` don't need a session (public Agent-market browsing,
 * design.md's interface contract) but are registered here alongside POST
 * for one discoverable module surface rather than splitting across files.
 */
export function registerAgentsRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/agents", { preHandler: app.requireSession }, async (request, reply) => {
    const parsed = createAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }

    // requireSession's preHandler already returned a 401 and short-circuited
    // the request if this weren't set — this check exists only to satisfy
    // the type system without a non-null assertion, not because it's
    // expected to trigger in practice.
    if (!request.address) {
      return reply.status(401).send({
        error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
      });
    }
    const agent = await createAgent(pool, request.address, parsed.data);

    return reply.status(201).send({
      agentId: agent.id,
      status: agent.status,
      createdAt: agent.createdAt.toISOString(),
      completedTaskCount: agent.completedTaskCount,
      qualityScore: agent.qualityScore,
    });
  });

  app.get("/agents", async (request, reply) => {
    const parsed = listAgentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }

    const { items, total } = await listAgentsForMarket(pool, parsed.data);
    return reply.send({
      items: items.map(toAgentSummaryJson),
      total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  });

  app.get("/agents/:agentId", async (request, reply) => {
    const parsed = agentIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }

    const agent = await getAgentDetail(pool, parsed.data.agentId);
    if (!agent) {
      return reply.status(404).send({ error: { message: "未找到该 Agent。" } });
    }
    return reply.send(toAgentSummaryJson(agent));
  });
}
