import type { ErrorCode } from "@agent-market/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { serverSessionId, writeInteractionEventToOutbox } from "../analytics/outbox-event.js";
import { getTaskById } from "../tasks/repository.js";
import { insertRating, getScoresForAgent, getRatingForTask } from "./repository.js";
import { aggregateQualityScore } from "./service.js";
import { submitRatingSchema, taskIdParamSchema } from "./schema.js";

const TASK_STATE_CONFLICT: ErrorCode = "TASK_STATE_CONFLICT";

/** Same pattern as disputes/routes.ts's own copy of this helper —
 * deliberately re-declared per module rather than shared/exported,
 * matching this codebase's established convention for this exact helper. */
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
 * `POST /tasks/:taskId/ratings` (F-1005). Requester-only, once-per-task,
 * post-settlement rating submission — the rating and the resulting
 * `agents.quality_score` recompute happen inside one transaction that
 * locks the target Agent's row (`SELECT ... FOR UPDATE`), so two ratings
 * landing for the same Agent (via two different tasks) concurrently can
 * never lose an update by both reading the pre-insert score list and
 * overwriting each other's aggregate (same "row lock before read-then-
 * write" discipline `disputes/routes.ts` uses for its own concurrent-
 * submission race, T-1002 round 2).
 */
export function registerRatingsRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/tasks/:taskId/ratings", { preHandler: app.requireSession }, async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }
    const bodyParsed = submitRatingSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { message: bodyParsed.error.message } });
    }
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }

    const task = await getTaskById(pool, paramsParsed.data.taskId);
    if (!task) {
      return reply.status(404).send({ error: { message: "任务不存在。" } });
    }
    if (task.requesterAddress.toLowerCase() !== sessionAddress.toLowerCase()) {
      return reply.status(403).send({ error: { message: "只有本任务的需求方才能提交评分。" } });
    }
    // AC-1004: "任务结算后...提交评分" — RELEASED/REFUNDED are this
    // Feature's two terminal settlement outcomes (F-1001/F-1002/F-1004);
    // neither ever transitions further, so this check does not need the
    // same row-lock-then-recheck treatment the still-mutable `disputes`
    // status check needed.
    if (task.status !== "RELEASED" && task.status !== "REFUNDED") {
      return reply.status(409).send({
        error: {
          code: TASK_STATE_CONFLICT,
          message: `任务当前状态为 ${task.status}，尚未结算，无法评分。`,
        },
      });
    }
    if (!task.acceptedAgentId) {
      return reply.status(409).send({
        error: { code: TASK_STATE_CONFLICT, message: `任务 ${task.id} 缺少接单 Agent，无法评分。` },
      });
    }
    const acceptedAgentId = task.acceptedAgentId;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM agents WHERE id = $1 FOR UPDATE`, [acceptedAgentId]);

      const rating = await insertRating(client, {
        taskId: task.id,
        requesterAddress: sessionAddress,
        score: bodyParsed.data.score,
        communicationScore: bodyParsed.data.communicationScore,
      });
      if (!rating) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          error: { code: TASK_STATE_CONFLICT, message: "该任务已提交过评分。" },
        });
      }

      const scores = await getScoresForAgent(client, acceptedAgentId);
      const qualityScore = aggregateQualityScore(scores);
      await client.query(`UPDATE agents SET quality_score = $2 WHERE id = $1`, [
        acceptedAgentId,
        qualityScore,
      ]);

      // F-1901 (T-1901): real RATE event, written atomically with the
      // rating itself.
      await writeInteractionEventToOutbox(client, {
        eventType: "RATE",
        sessionId: serverSessionId(task.id),
        clientEventId: `rate:${task.id}`,
        taskId: task.id,
        agentId: acceptedAgentId,
        actorAddress: sessionAddress,
      });

      await client.query("COMMIT");
      return reply.status(201).send({ ratingId: rating.id });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * T-1006: `GET /tasks/:taskId/ratings` — lets `RatingSection` (frontend)
   * check whether the current task already has a rating (404 if not) so
   * it can render the submission form vs. a read-only "已评分" display,
   * without submitting a throwaway `POST` just to read its 409. Public
   * read (no `requireSession`) — a rating's score is not sensitive; it is
   * already folded into `agents.quality_score`, which `GET /agents/:agentId`
   * already exposes to anyone.
   */
  app.get("/tasks/:taskId/ratings", async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }
    const rating = await getRatingForTask(pool, paramsParsed.data.taskId);
    if (!rating) {
      return reply.status(404).send({ error: { message: "该任务尚无评分记录。" } });
    }
    return reply.send({
      ratingId: rating.id,
      score: rating.score,
      communicationScore: rating.communicationScore,
      createdAt: rating.createdAt.toISOString(),
    });
  });
}
