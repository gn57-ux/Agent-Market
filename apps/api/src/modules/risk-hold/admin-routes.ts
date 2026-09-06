import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { formatZodError } from "../../shared/zod-error.js";
import { releaseRiskHoldSchema, riskHoldAgentParamsSchema } from "./schema.js";
import { getRiskHoldAuditLog, releaseAgent } from "./repository.js";

/** Same per-module duplication convention every other admin-routes.ts in
 * this codebase documents. */
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
 * F-2010/T-2008 (用户 2026-09-06 Q-2003 决策): the ONLY way an Agent's
 * `risk_hold_status` ever moves back to `NONE` —
 * `POST /admin/agents/:agentId/risk-hold/release`, plus a read-only
 * `GET /admin/agents/:agentId/risk-hold/audit-log` for reviewing the hold
 * history before deciding to release. Both `app.requireAdmin` (Feature
 * 16's own model, reused verbatim). A SEPARATE file/module from
 * `antifraud/admin-routes.ts` (same reasoning as that file's own doc
 * comment) — the HOLD side lives in `antifraud/admin-routes.ts`'s
 * `confirm` handler (which calls this module's `holdAgent`, never writes
 * the table itself); the RELEASE side lives here, its own independent
 * admin action, never implicit.
 */
export function registerRiskHoldAdminRoutes(app: FastifyInstance, pool: Pool): void {
  app.get(
    "/admin/agents/:agentId/risk-hold/audit-log",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = riskHoldAgentParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const entries = await getRiskHoldAuditLog(pool, paramsParsed.data.agentId);
      return reply.status(200).send({
        entries: entries.map((e) => ({
          id: e.id,
          agentId: e.agentId,
          riskSignalId: e.riskSignalId,
          action: e.action,
          actorAddress: e.actorAddress,
          reason: e.reason,
          occurredAt: e.occurredAt.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/admin/agents/:agentId/risk-hold/release",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = riskHoldAgentParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = releaseRiskHoldSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const actorAddress = requireSessionAddress(request, reply);
      if (!actorAddress) return reply;

      // N4 P1 fix: the status UPDATE and the audit INSERT must be one
      // atomic unit on one connection — see repository.ts's own doc
      // comment on `releaseAgent` for why passing a bare `Pool` was wrong.
      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");
        const result = await releaseAgent(dbClient, {
          agentId: paramsParsed.data.agentId,
          actorAddress,
          reason: bodyParsed.data.reason,
        });
        if (!result.ok) {
          await dbClient.query("ROLLBACK");
          return reply.status(409).send({ error: { message: "该 Agent 当前不处于 HOLD 状态。" } });
        }
        await dbClient.query("COMMIT");
        return reply
          .status(200)
          .send({ agentId: paramsParsed.data.agentId, riskHoldStatus: "NONE" });
      } catch (error) {
        await dbClient.query("ROLLBACK");
        throw error;
      } finally {
        dbClient.release();
      }
    },
  );
}
