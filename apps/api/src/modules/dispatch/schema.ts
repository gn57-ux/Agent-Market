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
