import { z } from "zod";

/**
 * F-2002/T-2001: `POST /evaluation/tasks/:taskId/submit`'s request body.
 * `agentId` is required in the body (not derivable from the session alone
 * — the same owner can control multiple Agents, F-501, so the URL's
 * `taskId` names WHICH evaluation task is being attempted, and the body
 * must separately name WHICH of the caller's own Agents is attempting it).
 */
export const submitEvaluationSchema = z.object({
  agentId: z.string().uuid(),
  submittedContent: z.string().min(1).max(20_000),
});

export type SubmitEvaluationInput = z.infer<typeof submitEvaluationSchema>;

export const submitParamsSchema = z.object({ taskId: z.string().uuid() });

/**
 * F-2003/T-2002: `POST /admin/evaluation/results/:id/review`'s request
 * body — the admin-supplied score/rationale for a `HUMAN_REQUIRED`
 * submission. `:id` in the URL names the SUBMISSION being reviewed (see
 * `admin-routes.ts`'s own doc comment for why the literal design.md path
 * segment says "results" even though no `evaluation_results` row exists
 * until this endpoint creates one).
 */
export const reviewSubmissionParamsSchema = z.object({ id: z.string().uuid() });

export const reviewSubmissionSchema = z.object({
  score: z.number().min(0).max(100),
  rationale: z.string().min(1).max(5_000),
});

export type ReviewSubmissionInput = z.infer<typeof reviewSubmissionSchema>;

/**
 * F-2004/T-2004: `POST /evaluation/results/:id/appeal`'s request — `:id` in
 * the URL is the ORIGINAL `evaluation_results` row being appealed.
 */
export const appealParamsSchema = z.object({ id: z.string().uuid() });

export const appealSchema = z.object({
  reason: z.string().min(1).max(5_000),
});

export type AppealInput = z.infer<typeof appealSchema>;

/**
 * F-2004/T-2004: `POST /admin/evaluation/appeals/:appealId/resolve`'s
 * request — the admin's re-review score/rationale, same shape as
 * `reviewSubmissionSchema` (T-2002) since it's the SAME action (a human
 * scoring a submission) just triggered by an appeal instead of the initial
 * `HUMAN_REQUIRED` queue.
 */
export const resolveAppealParamsSchema = z.object({ appealId: z.string().uuid() });

export const resolveAppealSchema = z.object({
  score: z.number().min(0).max(100),
  rationale: z.string().min(1).max(5_000),
});

export type ResolveAppealInput = z.infer<typeof resolveAppealSchema>;

/**
 * F-2003/T-2003: `POST /admin/evaluation/submissions/:id/ai-suggestion`'s
 * params — `:id` names the SUBMISSION (not a result; this endpoint may run
 * before any result exists), matching `reviewSubmissionParamsSchema`'s own
 * "URL names the submission" convention.
 */
export const aiSuggestionParamsSchema = z.object({ id: z.string().uuid() });
