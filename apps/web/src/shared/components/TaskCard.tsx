import type { TaskStatus } from "@agent-market/domain";
import { StatusBadge } from "./StatusBadge.js";

export interface TaskCardProps {
  taskId: string;
  title: string;
  /** Already-formatted display string (e.g. via Amount.formatAmount); this
   * component does not format or compute amounts itself. */
  budgetDisplay: string;
  status: TaskStatus;
}

export function TaskCard({ taskId, title, budgetDisplay, status }: TaskCardProps) {
  return (
    <article data-task-id={taskId}>
      <h3>{title}</h3>
      <p>{budgetDisplay}</p>
      <StatusBadge status={status} />
    </article>
  );
}
