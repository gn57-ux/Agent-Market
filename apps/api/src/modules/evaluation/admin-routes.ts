import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { formatZodError } from "../../shared/zod-error.js";
import { AiScorerError, generateAiScoreSuggestion } from "./ai-scorer.js";
import {
  aiSuggestionParamsSchema,
  resolveAppealParamsSchema,
  resolveAppealSchema,
  reviewSubmissionParamsSchema,
  reviewSubmissionSchema,
} from "./schema.js";
import {
  getAppealForResolve,
  getPendingReviewSubmissions,
  getSubmissionForAiSuggestion,
  getSubmissionForReview,
  insertResult,
  resolveAppeal,
  updateBaselineEvaluationStatusForResult,
} from "./repository.js";

/** Same per-module duplication convention `routes.ts` already documents —
 * an admin route still needs the caller's own address (as the reviewer),
 * even though `app.requireAdmin` already gates access. */
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
 * F-2003 (T-2002): the admin-facing half of the review lifecycle —
 * `GET /admin/evaluation/pending-review`, `POST /admin/evaluation/results/
 * :id/review`. Both gated by `app.requireAdmin` (Feature 16's own
 * permission model, reused verbatim — CLAUDE.md 原则 6, this codebase
 * already has exactly one home for "is this caller an admin").
 *
 * The literal path segment is "results/:id" (design.md's own interface
 * contract) even though `:id` names a SUBMISSION, not a result — no
 * `evaluation_results` row exists for a pending review until this
 * endpoint creates one. Kept as design.md specifies rather than silently
 * renaming the URL to "submissions/:id", since the URL itself is a real,
 * already-agreed interface contract, not an implementation detail this
 * Task is free to redecide.
 *
 * A SEPARATE file from `routes.ts` (same reasoning as `agents/admin-
 * review-routes.ts` vs `agents/routes.ts`) so a route's file location
 * alone signals which authorization it carries.
 */
export function registerEvaluationAdminRoutes(app: FastifyInstance, pool: Pool): void {
  app.get(
    "/admin/evaluation/pending-review",
    { preHandler: app.requireAdmin },
    async (_request, reply) => {
      const pending = await getPendingReviewSubmissions(pool);
      return reply.status(200).send({
        submissions: pending.map((row) => ({
          submissionId: row.submissionId,
          agentId: row.agentId,
          evaluationTaskId: row.evaluationTaskId,
          title: row.title,
          prompt: row.prompt,
          submittedContent: row.submittedContent,
          submittedAt: row.submittedAt.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/admin/evaluation/results/:id/review",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = reviewSubmissionParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = reviewSubmissionSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }

      const reviewerAddress = requireSessionAddress(request, reply);
      if (!reviewerAddress) return reply;

      // N4 real finding (P1, round 1): the eligibility check
      // (scoringMode/hasResult) and the `insertResult` write must be one
      // atomic unit — `FOR UPDATE OF es` (see `getSubmissionForReview`'s
      // own doc comment) locks the submission row so a second concurrent
      // review of the SAME submission blocks until this transaction
      // commits/rolls back, then correctly observes `hasResult: true`.
      const dbClient = await pool.connect();
      let submissionId: string;
      let resultId: string;
      try {
        await dbClient.query("BEGIN");
        const submission = await getSubmissionForReview(dbClient, paramsParsed.data.id, {
          forUpdate: true,
        });
        if (!submission) {
          await dbClient.query("ROLLBACK");
          return reply.status(404).send({ error: { message: "未找到该评测提交。" } });
        }
        if (submission.scoringMode !== "HUMAN_REQUIRED") {
          await dbClient.query("ROLLBACK");
          return reply
            .status(409)
            .send({ error: { message: "该评测任务为规则评分，不接受人工复核。" } });
        }
        if (submission.hasResult) {
          await dbClient.query("ROLLBACK");
          return reply.status(409).send({ error: { message: "该评测提交已完成评分。" } });
        }

        submissionId = submission.id;
        resultId = await insertResult(dbClient, {
          submissionId: submission.id,
          scoredBy: "HUMAN",
          reviewerAddress,
          score: bodyParsed.data.score,
          rationale: bodyParsed.data.rationale,
        });
        // F-2012/T-2009: same transaction as the result write itself.
        await updateBaselineEvaluationStatusForResult(
          dbClient,
          submission.agentId,
          bodyParsed.data.score,
        );
        await dbClient.query("COMMIT");
      } catch (error) {
        await dbClient.query("ROLLBACK");
        throw error;
      } finally {
        dbClient.release();
      }

      return reply.status(201).send({
        resultId,
        submissionId,
        scoredBy: "HUMAN",
        reviewerAddress,
        score: bodyParsed.data.score,
        rationale: bodyParsed.data.rationale,
      });
    },
  );

  /**
   * F-2004 (T-2004): `POST /admin/evaluation/appeals/:appealId/resolve` —
   * an admin re-review that resolves a real F-2004 appeal. Not literally
   * named in design.md's own interface-contract section (which only spells
   * out appeal CREATION), but a necessary, obviously-implied completion of
   * the flow it describes ("管理员复评后...产生新的 evaluation_results 记录")
   * — an appeal with no way to ever resolve it would be a dead-end UI
   * feature. Same double-write pattern as the initial review above: a NEW
   * `evaluation_results` row (`scored_by = 'HUMAN'`) AND the appeal's own
   * `status`/`resulting_evaluation_result_id` transition are one atomic
   * unit (the migration's own `evaluation_appeals_result_matches_status`
   * CHECK and composite same-submission FKs require both to land together
   * or not at all). Uses `getAppealForResolve`'s lock-then-fresh-read
   * pattern from the start (T-2002's own N4 round-2 finding already proved
   * a same-statement lock+check is unsafe under READ COMMITTED).
   */
  app.post(
    "/admin/evaluation/appeals/:appealId/resolve",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = resolveAppealParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = resolveAppealSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }

      const reviewerAddress = requireSessionAddress(request, reply);
      if (!reviewerAddress) return reply;

      const dbClient = await pool.connect();
      let resultId: string;
      try {
        await dbClient.query("BEGIN");
        const appeal = await getAppealForResolve(dbClient, paramsParsed.data.appealId, {
          forUpdate: true,
        });
        if (!appeal) {
          await dbClient.query("ROLLBACK");
          return reply.status(404).send({ error: { message: "未找到该申诉。" } });
        }
        if (appeal.status !== "PENDING") {
          await dbClient.query("ROLLBACK");
          return reply.status(409).send({ error: { message: "该申诉已完成复评。" } });
        }

        resultId = await insertResult(dbClient, {
          submissionId: appeal.submissionId,
          scoredBy: "HUMAN",
          reviewerAddress,
          score: bodyParsed.data.score,
          rationale: bodyParsed.data.rationale,
        });
        // F-2012/T-2009: same transaction as the result write itself.
        await updateBaselineEvaluationStatusForResult(
          dbClient,
          appeal.agentId,
          bodyParsed.data.score,
        );
        await resolveAppeal(dbClient, appeal.id, resultId);
        await dbClient.query("COMMIT");
      } catch (error) {
        await dbClient.query("ROLLBACK");
        throw error;
      } finally {
        dbClient.release();
      }

      return reply.status(201).send({
        resultId,
        appealId: paramsParsed.data.appealId,
        status: "RE_REVIEWED",
        scoredBy: "HUMAN",
        reviewerAddress,
        score: bodyParsed.data.score,
        rationale: bodyParsed.data.rationale,
      });
    },
  );

  /**
   * F-2003/T-2003 (design.md 决策 2, 用户 2026-09-06 Q-2001 决策的评测闭环
   * 一部分): `POST /admin/evaluation/submissions/:id/ai-suggestion` — an
   * admin-triggered, on-demand local-model score SUGGESTION for a
   * `HUMAN_REQUIRED` submission still awaiting human review. Deliberately
   * NOT automatic on submit (design comparison, CLAUDE.md 原则 3): (A,
   * chosen) admin-triggered synchronous call — no coupling between
   * submission latency/availability and a local Ollama daemon that might be
   * slow or down; (B, rejected) fire on every submission automatically —
   * would burn compute on submissions no admin reviews soon and make
   * `POST /evaluation/tasks/:taskId/submit`'s own response depend on an
   * external local service it has no other reason to need.
   *
   * Writes `scored_by = 'AI'`, `reviewer_address = NULL` — NEVER calls
   * `updateBaselineEvaluationStatusForResult` (an AI suggestion is
   * advisory, never a terminal decision — F-2012's admission gate must
   * only ever move on a RULE/HUMAN result) and is invisible to
   * `getPendingReviewSubmissions`/`getSubmissionForReview`'s own
   * `scored_by = 'HUMAN'`-scoped queue-exit checks, so a submission with
   * only an AI suggestion still requires real human review (design.md's
   * explicit "强制要求人工复核" for anything AI touches).
   */
  app.post(
    "/admin/evaluation/submissions/:id/ai-suggestion",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = aiSuggestionParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }

      const submission = await getSubmissionForAiSuggestion(pool, paramsParsed.data.id);
      if (!submission) {
        return reply.status(404).send({ error: { message: "未找到该评测提交。" } });
      }
      if (submission.scoringMode !== "HUMAN_REQUIRED") {
        return reply
          .status(409)
          .send({ error: { message: "该评测任务为规则评分，不需要 AI 辅助评分。" } });
      }
      if (submission.hasHumanResult) {
        return reply.status(409).send({ error: { message: "该评测提交已完成人工评分。" } });
      }

      let suggestion;
      try {
        suggestion = await generateAiScoreSuggestion(
          submission.prompt,
          submission.submittedContent,
        );
      } catch (error) {
        if (error instanceof AiScorerError) {
          return reply.status(502).send({ error: { message: error.message } });
        }
        throw error;
      }

      // N4 real finding (P2): the model call above can take up to 30s — an
      // admin could complete a real human review of this SAME submission
      // during that window. Re-check `hasHumanResult` inside a transaction,
      // locked, immediately before writing (not trusting the pre-check
      // above, which is now stale) — if a human result landed in the
      // meantime, discard this suggestion entirely rather than writing a
      // stale AI row behind a real terminal result.
      const dbClient = await pool.connect();
      let resultId: string;
      try {
        await dbClient.query("BEGIN");
        const fresh = await getSubmissionForAiSuggestion(dbClient, submission.id, {
          forUpdate: true,
        });
        if (!fresh || fresh.hasHumanResult) {
          await dbClient.query("ROLLBACK");
          return reply.status(409).send({ error: { message: "该评测提交已完成人工评分。" } });
        }
        resultId = await insertResult(dbClient, {
          submissionId: submission.id,
          scoredBy: "AI",
          reviewerAddress: null,
          score: suggestion.score,
          rationale: suggestion.rationale,
        });
        await dbClient.query("COMMIT");
      } catch (error) {
        await dbClient.query("ROLLBACK");
        throw error;
      } finally {
        dbClient.release();
      }

      return reply.status(201).send({
        resultId,
        submissionId: submission.id,
        scoredBy: "AI",
        score: suggestion.score,
        rationale: suggestion.rationale,
      });
    },
  );
}
