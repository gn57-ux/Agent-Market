// Single source of truth for domain error codes (PRD §11.4). Backend routes
// throw these, frontend error handling switches on these — nobody declares
// a free-standing string literal for one of these codes.
export const ERROR_CODES = [
  "WALLET_SIGNATURE_INVALID",
  "CHAIN_UNSUPPORTED",
  "TRANSACTION_NOT_FOUND",
  "TRANSACTION_NOT_CONFIRMED",
  "FUNDING_EVENT_MISMATCH",
  "TRANSACTION_ALREADY_USED",
  "TASK_STATE_CONFLICT",
  "IDEMPOTENCY_KEY_CONFLICT",
  "NO_ELIGIBLE_AGENT",
  "ACCEPTANCE_PERMIT_EXPIRED",
  "DELIVERABLE_HASH_MISMATCH",
  "RPC_TEMPORARILY_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
