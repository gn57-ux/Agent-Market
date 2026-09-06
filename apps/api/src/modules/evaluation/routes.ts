import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { requireOwnedAgent } from "../agents/service.js";
import { formatZodError } from "../../shared/zod-error.js";
import {
  appealParamsSchema,
  appealSchema,
  submitEvaluationSchema,
  submitParamsSchema,
} from "./schema.js";
import {
  getAgentForResult,
  getEvaluationTaskById,
  insertAppeal,
  insertResult,
  insertSubmission,
  markBaselineEvaluationStarted,
  parseRuleBasedCriteria,
  updateBaselineEvaluationStatusForResult,
} from "./repository.js";
import { scoreRuleBased } from "./rule-scorer.js";

/** Same per-module duplication convention as every other routes.ts in this
 * codebase (agents/tasks/dispatch/dag/disputes/ratings/deliverables/funds
 * all define their own copy) — a shared helper would be a shallow module
 * wrapping two lines, not real design knowledge (CLAUDE.md 原则 5). */
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
 * F-2002/F-2003 (T-2001): `POST /evaluation/tasks/:taskId/submit`. Ownership
 * is checked via `requireOwnedAgent` (agents/service.ts) — the SAME
 * function F-503/F-504/T-1605 already use for "does this session own this
 * Agent" (CLAUDE.md 原则 6, this rule has exactly one home).
 *
 * `RULE_BASED` tasks are scored INLINE, synchronously, in the same request
 * — design.md 决策 2's whole point is that rule scoring is deterministic
 * and needs no human in the loop, so there is no reason to defer it to a
 * background job. `HUMAN_REQUIRED` tasks only create the submission row;
 * T-2002 owns the review-queue/scoring endpoint for those.
 */
export function registerEvaluationRoutes(app: FastifyInstance, pool: Pool): void {
  app.post(
    "/evaluation/tasks/:taskId/submit",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = submitParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = submitEvaluationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }

      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) return reply;

      const ownership = await requireOwnedAgent(pool, sessionAddress, bodyParsed.data.agentId);
      if (!ownership.ok) {
        return reply.status(ownership.reason === "not_found" ? 404 : 403).send({
          error: {
            message:
              ownership.reason === "not_found"
                ? "未找到该 Agent。"
                : "只有 Agent 归属地址可以提交评测。",
          },
        });
      }

      const evaluationTask = await getEvaluationTaskById(pool, paramsParsed.data.taskId);
      if (!evaluationTask) {
        return reply.status(404).send({ error: { message: "未找到该评测任务。" } });
      }

      if (evaluationTask.scoringMode === "HUMAN_REQUIRED") {
        // F-2012/T-2009: the submission write and the NOT_STARTED->PENDING
        // admission-gate flip are one atomic unit (N4 real finding, P2: two
        // separate `pool.query` calls left a real gap — a failure or crash
        // between them left a real submission behind with the gate still
        // NOT_STARTED, and a client retry would only create a second
        // orphan submission on top of it).
        const dbClient = await pool.connect();
        let submissionId: string;
        try {
          await dbClient.query("BEGIN");
          submissionId = await insertSubmission(dbClient, {
            evaluationTaskId: evaluationTask.id,
            agentId: bodyParsed.data.agentId,
            submittedContent: bodyParsed.data.submittedContent,
          });
          await markBaselineEvaluationStarted(dbClient, bodyParsed.data.agentId);
          await dbClient.query("COMMIT");
        } catch (error) {
          await dbClient.query("ROLLBACK");
          throw error;
        } finally {
          dbClient.release();
        }
        return reply.status(201).send({ submissionId, status: "PENDING_HUMAN_REVIEW" });
      }

      // RULE_BASED: score immediately. N4 real finding (P1, round 1): the
      // rubric's criteria must parse BEFORE anything is written — the
      // original version wrote the submission first and only discovered a
      // malformed rubric afterward, permanently leaving an orphan
      // submission with no result (and a client retry would only pile up
      // more orphans). A rubric whose criteria don't parse is a real
      // data-integrity problem (someone inserted a malformed
      // evaluation_rubrics row), surfaced as 500 before any write happens.
      const criteria = parseRuleBasedCriteria(evaluationTask.criteria);
      if (!criteria) {
        request.log.error(
          { rubricId: evaluationTask.rubricId },
          "evaluation rubric criteria failed to parse for a RULE_BASED task",
        );
        return reply.status(500).send({ error: { message: "评测规则配置异常，请联系平台运营。" } });
      }
      const { score, rationale } = scoreRuleBased(bodyParsed.data.submittedContent, criteria);

      // The submission and its rule-computed result are one atomic unit —
      // a RULE_BASED submission with no result (or vice versa) is a state
      // this endpoint's own contract ("规则类立即评分") says can't exist
      // (N4 real finding, P1, round 1: `insertResult` failing after
      // `insertSubmission` already committed left exactly that state).
      const dbClient = await pool.connect();
      let submissionId: string;
      let resultId: string;
      try {
        await dbClient.query("BEGIN");
        submissionId = await insertSubmission(dbClient, {
          evaluationTaskId: evaluationTask.id,
          agentId: bodyParsed.data.agentId,
          submittedContent: bodyParsed.data.submittedContent,
        });
        resultId = await insertResult(dbClient, {
          submissionId,
          scoredBy: "RULE",
          reviewerAddress: null,
          score,
          rationale,
        });
        // F-2012/T-2009 (design.md 决策 3, 用户 2026-09-06 Q-2001 决策):
        // same transaction as the result write itself — the evaluation-
        // completion write path is the one place responsible for keeping
        // the admission gate in sync. Whether Go actually ENFORCES this
        // gate is a separate, independently-gated decision (see
        // `dispatch/routes.ts`'s `resolveEnforceBaselineEvaluationGate`) —
        // writing the real outcome here is always safe regardless.
        await updateBaselineEvaluationStatusForResult(dbClient, bodyParsed.data.agentId, score);
        await dbClient.query("COMMIT");
      } catch (error) {
        await dbClient.query("ROLLBACK");
        throw error;
      } finally {
        dbClient.release();
      }

      return reply.status(201).send({ submissionId, resultId, status: "SCORED", score, rationale });
    },
  );

  /**
   * F-2004 (T-2004): `POST /evaluation/results/:id/appeal` — the Agent
   * OWNER appeals a result. Ownership is resolved via `getAgentForResult`
   * (which Agent produced the submission this result scored) then checked
   * with the SAME `requireOwnedAgent` every other owner-gated endpoint in
   * this codebase uses — never trust a client-supplied `agentId` for who
   * gets to appeal what.
   */
  app.post(
    "/evaluation/results/:id/appeal",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = appealParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = appealSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }

      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) return reply;

      const ownership = await getAgentForResult(pool, paramsParsed.data.id);
      if (!ownership) {
        return reply.status(404).send({ error: { message: "未找到该评测结果。" } });
      }
      const agentOwnership = await requireOwnedAgent(pool, sessionAddress, ownership.agentId);
      if (!agentOwnership.ok) {
        return reply.status(agentOwnership.reason === "not_found" ? 404 : 403).send({
          error: {
            message:
              agentOwnership.reason === "not_found"
                ? "未找到该 Agent。"
                : "只有 Agent 归属地址可以提交申诉。",
          },
        });
      }

      // N4 real finding (P2): `insertAppeal` returns `null` (not a thrown
      // error) when this result already has an open `PENDING` appeal —
      // `evaluation_appeals_one_pending_per_result`'s own uniqueness
      // violation. Without this, retrying the request (or two browser tabs)
      // could create several independently-resolvable appeals for the same
      // original score.
      const appealId = await insertAppeal(pool, {
        submissionId: ownership.submissionId,
        evaluationResultId: paramsParsed.data.id,
        agentOwnerAddress: sessionAddress,
        reason: bodyParsed.data.reason,
      });
      if (!appealId) {
        return reply.status(409).send({ error: { message: "该评测结果已存在待处理的申诉。" } });
      }

      return reply.status(201).send({ appealId, status: "PENDING" });
    },
  );
}
