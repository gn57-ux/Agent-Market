/**
 * T-705: `POST /tasks/:taskId/match` has no request body — its only input
 * validation is the `taskId` path param, and `tasks/schema.ts` already
 * exports exactly that UUID-format schema (`taskIdParamSchema`). Re-exported
 * here rather than a second `z.object({ taskId: z.string().uuid(...) })`
 * definition, per the capsule's explicit instruction not to copy the UUID
 * regex to a third place.
 */
export { taskIdParamSchema } from "../tasks/schema.js";
