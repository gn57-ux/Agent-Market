import { assertExhaustive, type TaskStatus } from "@agent-market/domain";

export interface StatusBadgeProps {
  status: TaskStatus;
}

function labelFor(status: TaskStatus): string {
  switch (status.kind) {
    case "DRAFT":
      return "草稿";
    case "AWAITING_FUNDING":
      return "等待资金确认";
    case "OPEN":
      return "招募中";
    case "ACCEPTED":
      return "已接单";
    case "SUBMITTED":
      return "待验收";
    case "DISPUTED":
      return "争议中";
    case "RELEASED":
      return "已放款";
    case "REFUNDED":
      return "已退款";
    case "CANCELLED":
      return "已取消";
    default:
      return assertExhaustive(status, "StatusBadge.labelFor");
  }
}

/** Consumes TaskStatus exhaustively; a missing variant fails to compile. */
export function StatusBadge({ status }: StatusBadgeProps) {
  return <span data-status={status.kind}>{labelFor(status)}</span>;
}
