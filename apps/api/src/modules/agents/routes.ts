import type { FastifyReply, FastifyRequest, FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AgentMutationResult } from "./service.js";
import type { AgentRow } from "./repository.js";
import {
  createAgent,
  getAgentDetail,
  listAgentsForMarket,
  setAgentActiveStatus,
  testAgentInvocation,
  updateAgent,
} from "./service.js";
import {
  agentIdParamSchema,
  createAgentSchema,
  invocationTestSchema,
  listAgentsQuerySchema,
  updateAgentSchema,
} from "./schema.js";
import { formatZodError } from "../../shared/zod-error.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import { verifySession } from "../auth/session.service.js";
import { SESSION_COOKIE_NAME } from "../auth/session.middleware.js";
import { embedAgentOnSave } from "../embeddings/embed-on-save.js";

/** Shared response shape for both the list and detail endpoints (F-502).
 * `referencePrice` comes back from `pg` as a string (NUMERIC columns aren't
 * safely representable as JS `number`) — passed through as-is rather than
 * `Number()`-coerced, so a caller doesn't silently lose precision.
 * `payoutAddress` is included (not secret — the owner's own public
 * address, same visibility as `ownerAddress`) so T-505's edit page can
 * pre-fill it; there is no `PATCH` that omits it from the form without a
 * way to read the current value first. */
function toAgentSummaryJson(agent: AgentRow, viewerIsOwner: boolean) {
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
    // T-1203 round-2 Finding 1 (P1): this field is only the reference
    // string, never a resolved credential value (see repository.ts's
    // AgentRow.credentialRef doc comment) — but the reference string itself
    // must not reach anyone but the Agent's own owner, because copying it
    // into a DIFFERENT Agent used to be enough to borrow the victim's real
    // credential via the diagnostic endpoint (closed at the database layer
    // too, by 0013's partial unique index). `undefined` (key omitted by
    // JSON serialization) rather than `null` for a non-owner viewer — a
    // stranger isn't owed even "this Agent does/doesn't have one
    // configured".
    credentialRef: viewerIsOwner ? agent.credentialRef : undefined,
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
 * Best-effort session lookup that never fails the request — unlike
 * `app.requireSession` (a preHandler that short-circuits with 401 when
 * absent/invalid), `GET /agents` and `GET /agents/:agentId` must stay
 * public for market browsing (design.md's interface contract) while still
 * needing to know "is the caller this Agent's own owner" to decide whether
 * `credentialRef` belongs in the response. Calls `verifySession` directly —
 * the same primitive `app.requireSession` itself uses — rather than
 * changing that decorator's signature (session.middleware.ts's own doc
 * comment: it's an interface-freeze point, changing it needs a dedicated
 * Task, not a direct edit here).
 */
async function getOptionalSessionAddress(
  request: FastifyRequest,
  pool: Pool,
): Promise<string | undefined> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return undefined;
  }
  const verified = await verifySession(pool, token);
  return verified?.address;
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
  if (result.reason === "credential_ref_conflict") {
    return reply
      .status(409)
      .send({ error: { message: "该凭据引用已被另一个 Agent 使用，请更换引用。" } });
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
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }
    const result = await createAgent(pool, sessionAddress, parsed.data);
    if (!result.ok) {
      return reply
        .status(409)
        .send({ error: { message: "该凭据引用已被另一个 Agent 使用，请更换引用。" } });
    }

    // F-1301/T-1302: fire-and-forget, never awaited — createAgent's own
    // transaction has already committed by this point (insertAgent), so
    // this runs entirely outside it, and any failure here (Provider
    // unavailable, timeout, malformed response) is swallowed inside
    // embedAgentOnSave itself, never surfacing to this response.
    void embedAgentOnSave(pool, result.agent).catch(() => {
      // Unreachable in practice (embedAgentOnSave never rejects) — a
      // last-resort guard against an unhandled rejection crashing the
      // process if that contract is ever violated by a future change.
    });

    return reply.status(201).send({
      agentId: result.agent.id,
      status: result.agent.status,
      createdAt: result.agent.createdAt.toISOString(),
      completedTaskCount: result.agent.completedTaskCount,
      qualityScore: result.agent.qualityScore,
    });
  });

  app.get("/agents", async (request, reply) => {
    const parsed = listAgentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const viewerAddress = await getOptionalSessionAddress(request, pool);
    const normalizedViewer = viewerAddress ? normalizeAddress(viewerAddress) : undefined;
    const { items, total } = await listAgentsForMarket(pool, parsed.data);
    return reply.send({
      items: items.map((agent) =>
        toAgentSummaryJson(agent, agent.ownerAddress === normalizedViewer),
      ),
      total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  });

  app.get("/agents/:agentId", async (request, reply) => {
    const parsed = agentIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const agent = await getAgentDetail(pool, parsed.data.agentId);
    if (!agent) {
      return reply.status(404).send({ error: { message: "未找到该 Agent。" } });
    }
    const viewerAddress = await getOptionalSessionAddress(request, pool);
    const viewerIsOwner =
      viewerAddress !== undefined && agent.ownerAddress === normalizeAddress(viewerAddress);
    return reply.send(toAgentSummaryJson(agent, viewerIsOwner));
  });

  app.patch("/agents/:agentId", { preHandler: app.requireSession }, async (request, reply) => {
    const paramsParsed = agentIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
    }
    const bodyParsed = updateAgentSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
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
    // F-1301/T-1302: see the identical comment on POST /agents above — same
    // fire-and-forget contract, re-embedding on every successful update
    // (design.md: "创建或更新成功后...触发一次"), not only when
    // description/category/skillTags specifically changed.
    void embedAgentOnSave(pool, result.agent).catch(() => {});

    // Always the Agent's own owner here — updateAgent already enforced
    // ownership above.
    return reply.send(toAgentSummaryJson(result.agent, true));
  });

  // F-1204/T-1203: diagnostic-only — proves the invocation-client.ts
  // protocol (timeout/auth/idempotency) is real, working code without
  // driving any task/dispatch/settlement state (design.md's "范围边界").
  app.post(
    "/agents/:agentId/invocation-test",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = invocationTestSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const result = await testAgentInvocation(
        pool,
        sessionAddress,
        paramsParsed.data.agentId,
        bodyParsed.data.payload,
      );
      if (!result.ok) {
        return sendMutationFailure(reply, result);
      }
      return reply.send(
        result.result.ok
          ? { ok: true, statusCode: result.result.statusCode }
          : { ok: false, reason: result.result.reason, message: result.result.message },
      );
    },
  );

  app.post(
    "/agents/:agentId/activate",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
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
      // Always the Agent's own owner here — setAgentActiveStatus already
      // enforced ownership above.
      return reply.send(toAgentSummaryJson(result.agent, true));
    },
  );

  app.post(
    "/agents/:agentId/deactivate",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = agentIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
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
      // Always the Agent's own owner here — setAgentActiveStatus already
      // enforced ownership above.
      return reply.send(toAgentSummaryJson(result.agent, true));
    },
  );
}
