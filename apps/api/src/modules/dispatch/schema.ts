import { z } from "zod";
import { agentIdParamSchema } from "../agents/schema.js";
import { taskIdParamSchema } from "../tasks/schema.js";

/**
 * T-705: `POST /tasks/:taskId/match` has no request body — its only input
 * validation is the `taskId` path param, and `tasks/schema.ts` already
 * exports exactly that UUID-format schema (`taskIdParamSchema`). Re-exported
 * here rather than a second `z.object({ taskId: z.string().uuid(...) })`
 * definition, per the capsule's explicit instruction not to copy the UUID
 * regex to a third place.
 */
export { taskIdParamSchema } from "../tasks/schema.js";

/**
 * `GET /tasks/:taskId/agents/:agentId/acceptance-permit`'s (T-806,
 * replacing T-803's `GET /tasks/:taskId/my-acceptance-permit`) path params
 * — both already-established UUID-format schemas
 * (`tasks/schema.ts`'s `taskIdParamSchema.shape.taskId`,
 * `agents/schema.ts`'s `agentIdParamSchema.shape.agentId`), merged rather
 * than a third independently-typed UUID regex.
 */
export const taskAgentIdParamSchema = z.object({
  taskId: taskIdParamSchema.shape.taskId,
  agentId: agentIdParamSchema.shape.agentId,
});

/**
 * `GET /tasks/agents/candidate-invitations`'s (T-808) query params —
 * pagination only, no filter params, since the ONLY scoping input this
 * endpoint accepts is the caller's own session address (never a
 * client-supplied address/agentId). Same coercion/bounds as
 * `tasks/schema.ts`'s `listTasksQuerySchema` (`page`/`pageSize`): bounded
 * `page` so `(page - 1) * pageSize` can never approach PostgreSQL's int4
 * range, `pageSize` capped at 20 (F-608's "分页默认每页不超过 20 条" convention),
 * both re-derived here rather than imported — this module already
 * re-exports `taskIdParamSchema` from `tasks/schema.ts` for an identical
 * shared-shape reason, but a pagination schema is generic enough (no
 * task-specific validation) that duplicating the two bounded-number
 * fields costs less than an import coupling this module to
 * `tasks/schema.ts`'s pagination internals.
 */
export const candidateInvitationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20),
});
