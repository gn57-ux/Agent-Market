import { assertExhaustive, type TaskStatus } from "@agent-market/domain";
import { StatusChip, type StatusChipTone } from "./StatusChip.js";

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

function toneFor(status: TaskStatus): StatusChipTone {
  switch (status.kind) {
    case "DRAFT":
    case "AWAITING_FUNDING":
      return "neutral";
    case "OPEN":
    case "ACCEPTED":
      return "info";
    case "SUBMITTED":
    case "DISPUTED":
      return "warning";
    case "RELEASED":
      return "success";
    case "REFUNDED":
    case "CANCELLED":
      return "neutral";
    default:
      return assertExhaustive(status, "StatusBadge.toneFor");
  }
}

/** Consumes TaskStatus exhaustively; a missing variant fails to compile. */
export function StatusBadge({ status }: StatusBadgeProps) {
  return <StatusChip label={labelFor(status)} tone={toneFor(status)} />;
}
