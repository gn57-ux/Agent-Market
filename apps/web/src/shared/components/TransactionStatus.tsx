import {
  assertExhaustive,
  type TransactionStatus as TransactionStatusValue,
} from "@agent-market/domain";

export interface TransactionStatusProps {
  status: TransactionStatusValue;
}

function labelFor(status: TransactionStatusValue): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "awaitingSignature":
      return "等待钱包签名…";
    case "pending":
      return "交易已提交，等待广播确认…";
    case "confirming":
      return `确认中（${status.confirmations} 次确认）…`;
    case "verifying":
      return "等待后端复核…";
    case "rpcRecoveryPending":
      return "网络暂时不可用，可点击重试";
    case "confirmed":
      return "已确认";
    case "failed":
      return `失败：${status.reason}`;
    default:
      return assertExhaustive(status, "TransactionStatus.labelFor");
  }
}

/** Consumes TransactionStatus exhaustively, including the two recoverable
 * states (verifying, rpcRecoveryPending); a missing variant fails to compile. */
export function TransactionStatusView({ status }: TransactionStatusProps) {
  return <span data-transaction-status={status.kind}>{labelFor(status)}</span>;
}
