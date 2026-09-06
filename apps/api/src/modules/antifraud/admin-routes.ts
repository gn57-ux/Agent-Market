import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { formatZodError } from "../../shared/zod-error.js";
import { holdAgent } from "../risk-hold/repository.js";
import { listRiskSignalsQuerySchema, riskSignalParamsSchema } from "./schema.js";
import { getRiskSignalById, getRiskSignals, resolveRiskSignal } from "./repository.js";

/**
 * F-2010/T-2008 (用户 2026-09-06 Q-2003 决策): confirming one of these
 * three signal types is what triggers a real HOLD — `DUPLICATE_ACCOUNT`
 * is deliberately excluded (T-2007 是 DEFERRED，从未有检测器产生这种信
 * 号；即使未来某个信号类型需要不同的处罚规则，这里显式枚举而不是"任何
 * confirm 都 HOLD"，让"哪些信号类型触发处罚"本身保持可审查、不隐式)。
 */
const HOLD_TRIGGERING_SIGNAL_TYPES = new Set(["SCORE_MANIPULATION", "COLLUSION", "FAKE_DELIVERY"]);

/** Same per-module duplication convention every other admin-routes.ts in
 * this codebase documents (evaluation/admin-routes.ts, agents/admin-
 * review-routes.ts) — an admin route still needs the caller's own address
 * (as the reviewer), even though `app.requireAdmin` already gates access. */
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
 * F-2010/T-2008: `GET /admin/risk-signals`（风险信号队列）/
 * `POST /admin/risk-signals/:id/confirm`/`dismiss`（治理确认端点）。同
 * `evaluation/admin-routes.ts` 一样，一个独立文件承载 `app.requireAdmin`
 * 权限（Feature 16 既有模型，复用而非重造）。
 *
 * **用户 2026-09-06 Q-2003 决策落地**：`confirm` 一个 `SCORE_MANIPULATION`/
 * `COLLUSION`/`FAKE_DELIVERY` 信号，会在同一事务内先把
 * `risk_signals.status` 转为 `CONFIRMED`，再调用独立的 `risk-hold` 模块把
 * 该 Agent 置为 `risk_hold_status = 'HELD'`（真实的撮合排除后果，AC-2003
 * 后半"确认后才有实际状态变更"）。design.md 决策 1 的硬边界（检测/治理
 * 模块不得直接写 `agents`/`tasks`/链上交易）在这里成立的方式是：本文件
 * 只ORCHESTRATE（决定何时调用），从不自己执行 `UPDATE agents`/`INSERT
 * INTO risk_hold_audit_logs`——那些语句只存在于 `risk-hold/repository.ts`
 * 里，这是"独立处罚模块"字面的意思。`dismiss` 或非上述三种信号类型的
 * `confirm` 均不触发 HOLD。解除 HOLD 是一个完全独立的管理员动作
 * （`risk-hold/admin-routes.ts` 的 `POST /admin/agents/:agentId/risk-hold/
 * release`），本文件从不调用它——同一份用户指令的"解除 HOLD 必须通过明确
 * 的管理员操作...不能靠修改检测记录或重新评测静默清除"。
 */
export function registerAntifraudAdminRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/admin/risk-signals", { preHandler: app.requireAdmin }, async (request, reply) => {
    const queryParsed = listRiskSignalsQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(queryParsed.error) } });
    }
    const { status, page, pageSize } = queryParsed.data;
    const result = await getRiskSignals(pool, { status, page, pageSize });
    return reply.status(200).send({
      signals: result.items.map((s) => ({
        id: s.id,
        signalType: s.signalType,
        subjectAgentId: s.subjectAgentId,
        subjectAddress: s.subjectAddress,
        evidence: s.evidence,
        status: s.status,
        detectedAt: s.detectedAt.toISOString(),
        reviewedBy: s.reviewedBy,
        reviewedAt: s.reviewedAt ? s.reviewedAt.toISOString() : null,
      })),
      total: result.total,
      page,
      pageSize,
    });
  });

  async function handleResolve(
    request: FastifyRequest,
    reply: FastifyReply,
    status: "CONFIRMED" | "DISMISSED",
  ): Promise<FastifyReply> {
    const paramsParsed = riskSignalParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
    }
    const reviewerAddress = requireSessionAddress(request, reply);
    if (!reviewerAddress) return reply;

    // F-2010/T-2008 (Q-2003): the status transition and the (possible)
    // HOLD are one atomic unit — a CONFIRMED signal that failed to
    // actually place the Agent on HOLD (or vice versa) would be exactly
    // the "governance record and real consequence disagree" bug this
    // Feature exists to prevent.
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      const resolvedId = await resolveRiskSignal(
        dbClient,
        paramsParsed.data.id,
        status,
        reviewerAddress,
      );
      if (!resolvedId) {
        await dbClient.query("ROLLBACK");
        // N4 P2 fix: read via the SAME checked-out `dbClient`, never
        // `pool` — querying `pool` here while `dbClient` is still held
        // (released only in `finally`, after this function returns) would
        // require a second connection per in-flight request; under
        // concurrent 404/409s that can exhaust the pool with every request
        // holding one connection and waiting on a second, deadlocking it.
        const existing = await getRiskSignalById(dbClient, paramsParsed.data.id);
        if (!existing) {
          return reply.status(404).send({ error: { message: "未找到该风险信号。" } });
        }
        return reply.status(409).send({ error: { message: "该风险信号已完成审核。" } });
      }

      if (status === "CONFIRMED") {
        const signal = await getRiskSignalById(dbClient, resolvedId);
        if (signal?.subjectAgentId && HOLD_TRIGGERING_SIGNAL_TYPES.has(signal.signalType)) {
          await holdAgent(dbClient, {
            agentId: signal.subjectAgentId,
            riskSignalId: signal.id,
            actorAddress: reviewerAddress,
            reason: `risk_signals ${signal.id}（${signal.signalType}）已被管理员确认`,
          });
        }
      }
      await dbClient.query("COMMIT");
      return reply.status(200).send({ id: resolvedId, status, reviewedBy: reviewerAddress });
    } catch (error) {
      await dbClient.query("ROLLBACK");
      throw error;
    } finally {
      dbClient.release();
    }
  }

  app.post(
    "/admin/risk-signals/:id/confirm",
    { preHandler: app.requireAdmin },
    async (request, reply) => handleResolve(request, reply, "CONFIRMED"),
  );

  app.post(
    "/admin/risk-signals/:id/dismiss",
    { preHandler: app.requireAdmin },
    async (request, reply) => handleResolve(request, reply, "DISMISSED"),
  );
}
