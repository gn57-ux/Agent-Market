import type { FastifyReply, FastifyRequest, FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AgentMutationResult } from "./service.js";
import type { AgentRow } from "./repository.js";
import {
  createAgent,
  getAgentDetail,
  listAgentsForMarket,
  setAgentActiveStatus,
  updateAgent,
} from "./service.js";
import {
  agentIdParamSchema,
  createAgentSchema,
  listAgentsQuerySchema,
  updateAgentSchema,
} from "./schema.js";

/** Shared response shape for both the list and detail endpoints (F-502).
 * `referencePrice` comes back from `pg` as a string (NUMERIC columns aren't
 * safely representable as JS `number`) — passed through as-is rather than
 * `Number()`-coerced, so a caller doesn't silently lose precision.
 * `payoutAddress` is included (not secret — the owner's own public
 * address, same visibility as `ownerAddress`) so T-505's edit page can
 * pre-fill it; there is no `PATCH` that omits it from the form without a
 * way to read the current value first. */
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
    payoutAddress: agent.payoutAddress,
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
 * All four mutating/authenticated routes below attach `app.requireSession`
 * as a preHandler, which either short-circuits the request with a 401 or
 * populates `request.address`. This helper exists only to read that value
 * back without a non-null assertion (`@typescript-eslint/no-non-null-
 * assertion` is an error in this project) — the 401 branch here is
 * defensive, not expected to actually trigger given requireSession already
 * ran first.
 */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

/** Shared 404/403 handling for updateAgent/setAgentActiveStatus's
 * not_found/forbidden results (F-503/F-504, AC-505). */
function sendMutationFailure(
  reply: FastifyReply,
  result: Extract<AgentMutationResult, { ok: false }>,
) {
  if (result.reason === "not_found") {
    return reply.status(404).send({ error: { message: "未找到该 Agent。" } });
  }
  return reply.status(403).send({ error: { message: "只有 Agent 归属地址可以执行此操作。" } });
}

/**
 * Registers the full F-501/F-502/F-503/F-504 Agent route surface. Wrapped
 * in its own `app.register(...)` at the call site (see app.ts), not called
 * directly after `buildApp()` returns: the session-protected routes below
 * use `app.requireSession` as a preHandler, and that decorator is only
 * guaranteed to exist once `registerSessionMiddleware`'s own registration
 * has finished — see session.middleware.ts's doc comment. `GET /agents` and
 * `GET /agents/:agentId` don't need a session (public Agent-market
 * browsing, design.md's interface contract) but are registered here
 * alongside the rest for one discoverable module surface rather than
 * splitting across files.
 */
export function registerAgentsRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/agents", { preHandler: app.requireSession }, async (request, reply) => {
    const parsed = createAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }

    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }
    const agent = await createAgent(pool, sessionAddress, parsed.data);

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

  app.patch("/agents/:agentId", { preHandler: app.requireSession }, async (request, reply) => {
    const paramsParsed = agentIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }
    const bodyParsed = updateAgentSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { message: bodyParsed.error.message } });
    }
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }

    const result = await updateAgent(
      pool,
      sessionAddress,
      paramsParsed.data.agentId,
      bodyParsed.data,
    );
    if (!result.ok) {
      return sendMutationFailure(reply, result);
    }
    return reply.send(toAgentSummaryJson(result.agent));
  });

  app.post(
    "/agents/:agentId/activate",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: paramsParsed.error.message } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const result = await setAgentActiveStatus(
        pool,
        sessionAddress,
        paramsParsed.data.agentId,
        "ACTIVE",
      );
      if (!result.ok) {
        return sendMutationFailure(reply, result);
      }
      return reply.send(toAgentSummaryJson(result.agent));
    },
  );

  app.post(
    "/agents/:agentId/deactivate",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: paramsParsed.error.message } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const result = await setAgentActiveStatus(
        pool,
        sessionAddress,
        paramsParsed.data.agentId,
        "INACTIVE",
      );
      if (!result.ok) {
        return sendMutationFailure(reply, result);
      }
      return reply.send(toAgentSummaryJson(result.agent));
    },
  );
}
