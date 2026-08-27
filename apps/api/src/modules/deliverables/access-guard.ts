/**
 * F-908: single implementation of "who may read a deliverable's actual
 * file content" — the task's own requester, or its accepted Agent, and no
 * one else. `GET /tasks/:taskId/deliverables/latest/file` (T-907) is the
 * only current call site; design.md's own note ("`access-guard.ts` 是唯一的
 * 下载权限判断来源...不在路由层散落权限判断") means any future
 * content-reading endpoint must also route its authorization decision
 * through this function rather than re-deriving the rule.
 *
 * Deliberately does NOT check task status or deadlines — unlike F-906's
 * `checkSubmissionAllowed` (repository.ts), which gates WHO may create a
 * new deliverable and WHEN, this only answers "is this session one of the
 * two parties to this task," a fact that never becomes false once true
 * (a task's requester/accepted Agent don't change after acceptance).
 */
export function isAuthorizedForDeliverableAccess(
  task: { requesterAddress: string; acceptedAgentAddress: string | null },
  sessionAddress: string,
): boolean {
  const normalizedSession = sessionAddress.toLowerCase();
  if (task.requesterAddress.toLowerCase() === normalizedSession) {
    return true;
  }
  return (
    task.acceptedAgentAddress !== null &&
    task.acceptedAgentAddress.toLowerCase() === normalizedSession
  );
}
