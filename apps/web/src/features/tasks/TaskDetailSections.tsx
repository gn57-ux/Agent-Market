import { assertExhaustive, type TaskStatus } from "@agent-market/domain";
import { AcceptanceSection } from "../acceptance/AcceptanceSection.js";
import { SubmissionSection } from "../deliverables/SubmissionSection.js";
import { FundingSection } from "./task-detail-sections/FundingSection.js";

export interface TaskDetailSectionsProps {
  status: TaskStatus;
  taskId: string;
}

/**
 * Explicit composition root for `/tasks/:taskId` (design.md 方案 C, T-608
 * capsule risk note): each status-specific section is a plain `case` here,
 * not a runtime-registered block — Feature 7/8/9/10 add their own section by
 * adding an import and a case, never a plugin/registry mechanism. The switch
 * is exhaustive over `TaskStatus["kind"]` via `assertExhaustive`, so adding a
 * new status variant to `@agent-market/domain` without adding its case here
 * fails to compile instead of silently rendering nothing.
 *
 * Exhaustiveness itself is a compile-time guarantee, not something a runtime
 * test can exercise directly — proven by TypeScript rejecting a missing case
 * (or a stray `default:` that would defeat this check), not by a test case.
 */
export function TaskDetailSections({ status, taskId }: TaskDetailSectionsProps) {
  switch (status.kind) {
    case "DRAFT":
    case "AWAITING_FUNDING":
      return <FundingSection taskId={taskId} />;
    case "OPEN":
      // Feature 7's CandidateSection vs. Feature 8's AcceptanceSection:
      // AcceptanceSection decides between the two itself (see its own doc
      // comment) — this stays the one-line-import + one-case change the
      // T-802 capsule's verification note requires.
      return <AcceptanceSection taskId={taskId} />;
    case "ACCEPTED":
    case "SUBMITTED":
      // Feature 9's SubmissionSection decides for itself (session address
      // vs. `task.acceptedAgentAddress`, task status) whether to render
      // the upload/submit form or a read-only view — this stays the one
      // import + one case AC-907 requires.
      //
      // `key={taskId}` (N4 round 1 P1, Codex): this route (`/tasks/:taskId`)
      // can navigate from one task to another WITHOUT unmounting
      // `TaskDetailPage`'s component tree — `react-router`'s `useParams`
      // just returns a new value, the same `SubmissionSection` instance
      // stays mounted. Without a key, a hash already computed (and staged
      // for signing) for task A would still be sitting in that instance's
      // local state after navigating to task B, and could be submitted
      // against B's `submitResult` call instead — the exact bug this
      // finding identified. Keying on `taskId` forces React to fully
      // unmount/remount the section (discarding ALL of its local state,
      // including `useTransactionFlow`'s own internal status, which this
      // component has no other way to reset) whenever the task identity
      // changes, rather than SubmissionSection trying to enumerate and
      // manually clear every piece of state that could go stale.
      return <SubmissionSection key={taskId} taskId={taskId} />;
    case "DISPUTED":
    case "RELEASED":
    case "REFUNDED":
    case "CANCELLED":
      return null;
    default:
      return assertExhaustive(status, "TaskDetailSections");
  }
}
