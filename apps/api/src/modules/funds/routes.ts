import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { formatZodError } from "../../shared/zod-error.js";
import { isAdminAddress } from "../admin/repository.js";
import { getAgentById } from "../agents/repository.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import {
  getAgentFundsSummary,
  getPlatformFundsSummary,
  getRequesterFundsSummary,
} from "./repository.js";
import { agentIdParamSchema, requesterAddressParamSchema } from "./schema.js";

/** Same pattern as every other module's own copy of this helper
 * (ratings/routes.ts's own doc comment: deliberately re-declared per
 * module, not shared). */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

/**
 * F-1608/design.md 接口契约: the requester and agent views are "本人（地址
 * 匹配）或管理员可访问" — this is the ONE place that check is made (both
 * routes below call it), so the self-or-admin rule can't drift between the
 * two call sites. Returns `true` for a match; the caller is responsible
 * for the 403 response, keeping this function a pure predicate.
 */
async function isSelfOrAdmin(
  pool: Pool,
  sessionAddress: string,
  targetAddress: string,
): Promise<boolean> {
  if (normalizeAddress(sessionAddress) === normalizeAddress(targetAddress)) {
    return true;
  }
  return isAdminAddress(pool, normalizeAddress(sessionAddress));
}

/**
 * F-1608 (T-1608): three read-only funds views. `GET /funds/requester/...`
 * and `GET /funds/agent/...` use `app.requireSession` (need a verified
 * caller identity to run the self-or-admin check above); `GET
 * /funds/platform` uses `app.requireAdmin` directly — no self-access
 * concept applies to a platform-wide total.
 */
export function registerFundsRoutes(app: FastifyInstance, pool: Pool): void {
  app.get(
    "/funds/requester/:address",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const parsed = requesterAddressParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }
      if (!(await isSelfOrAdmin(pool, sessionAddress, parsed.data.address))) {
        return reply.status(403).send({
          error: { message: "只能查看自己的资金视图，或由管理员查看。" },
        });
      }

      const summary = await getRequesterFundsSummary(pool, normalizeAddress(parsed.data.address));
      return reply.send(summary);
    },
  );

  app.get("/funds/agent/:agentId", { preHandler: app.requireSession }, async (request, reply) => {
    const parsed = agentIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }

    const agent = await getAgentById(pool, parsed.data.agentId);
    if (!agent) {
      return reply.status(404).send({ error: { message: "未找到该 Agent。" } });
    }
    if (!(await isSelfOrAdmin(pool, sessionAddress, agent.ownerAddress))) {
      return reply.status(403).send({
        error: { message: "只能查看自己 Agent 的资金视图，或由管理员查看。" },
      });
    }

    const summary = await getAgentFundsSummary(pool, parsed.data.agentId);
    return reply.send(summary);
  });

  app.get("/funds/platform", { preHandler: app.requireAdmin }, async (_request, reply) => {
    const summary = await getPlatformFundsSummary(pool);
    return reply.send(summary);
  });
}
