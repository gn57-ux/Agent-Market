import { assertExhaustive, type TaskStatus } from "@agent-market/domain";
import { AcceptanceSection } from "../acceptance/AcceptanceSection.js";
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
    case "DISPUTED":
    case "RELEASED":
    case "REFUNDED":
    case "CANCELLED":
      return null;
    default:
      return assertExhaustive(status, "TaskDetailSections");
  }
}
