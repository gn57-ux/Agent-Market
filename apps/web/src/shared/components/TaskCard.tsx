import type { TaskStatus } from "@agent-market/domain";
import { StatusBadge } from "./StatusBadge.js";

export interface TaskCardProps {
  taskId: string;
  title: string;
  /** Already-formatted display string (e.g. via Amount.formatAmount); this
   * component does not format or compute amounts itself. */
  budgetDisplay: string;
  status: TaskStatus;
  /** All optional below — every consumer that has the real field (task
   * market/my-tasks/my-work list pages, all backed by the real `TaskRecord`
   * API shape) passes it; a card rendered from a narrower record just omits
   * that row rather than fabricating a placeholder value. */
  category?: string;
  description?: string;
  skillTags?: string[];
  /** ISO 8601 delivery deadline straight from the API — this component owns
   * turning it into the "距交付 N 天" / "已截止" relative label itself
   * (design.md's task-market reference) so every caller doesn't reimplement
   * the same date-diff math. */
  deliveryDeadline?: string;
  requesterAddress?: string;
}

function shortenAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

function deadlineLabel(deliveryDeadline: string): string {
  const deadlineMs = new Date(deliveryDeadline).getTime();
  if (Number.isNaN(deadlineMs)) return deliveryDeadline;
  const remainingMs = deadlineMs - Date.now();
  // Codex review (N4, P2): checking `remainingMs <= 0` FIRST, before the
  // day-rounding math below, matters — a deadline that passed 2 hours ago
  // gives `remainingMs` a small negative value; `Math.ceil()` on that
  // fraction rounds to `0`, which the old `daysLeft === 0` branch read as
  // "今天截止" (due today) instead of "已截止" (already overdue). Any
  // already-passed deadline, however recently, must say 已截止.
  if (remainingMs <= 0) return "已截止";
  const daysLeft = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  if (daysLeft === 0) return "今天截止";
  return `${daysLeft} 天后截止`;
}

/**
 * design.md's business-screen rule for Task Market: "editorial list/grid
 * hybrid with strong task title, budget, deadline, required skills and
 * status" (docs/stitch_agent_market_landing_page 2/
 * agent_market_task_market_updated). One bordered card, no decorative
 * shadow at rest (design.md's `cardLight`), category + status chips on top,
 * skill tags, then a budget/deadline/requester footer row.
 */
export function TaskCard({
  taskId,
  title,
  budgetDisplay,
  status,
  category,
  description,
  skillTags,
  deliveryDeadline,
  requesterAddress,
}: TaskCardProps) {
  return (
    <article
      data-task-id={taskId}
      className="flex h-full flex-col rounded-card-compact border border-divider-light bg-canvas-light p-6 transition-colors hover:border-action-blue"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {category && (
          <span className="rounded bg-canvas-warm px-2 py-1 text-caption font-medium text-ink-primary">
            {category}
          </span>
        )}
        <StatusBadge status={status} />
      </div>
      <h3 className="mb-2 text-lg font-semibold text-ink-primary">{title}</h3>
      {description && (
        <p className="mb-4 line-clamp-2 text-caption text-ink-secondary">{description}</p>
      )}
      {skillTags && skillTags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {skillTags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-canvas-warm px-2 py-1 text-caption font-medium text-ink-primary"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-divider-light pt-4 text-caption">
        <span className="font-medium text-ink-primary">{budgetDisplay}</span>
        {deliveryDeadline && (
          <span className="text-ink-secondary">{deadlineLabel(deliveryDeadline)}</span>
        )}
        {requesterAddress && (
          <span className="font-mono text-ink-secondary">{shortenAddress(requesterAddress)}</span>
        )}
      </div>
    </article>
  );
}
