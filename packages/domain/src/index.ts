export type { TaskStatus, TaskStatusKind } from "./task-status.js";
export type {
  TransactionStatus,
  TransactionStatusKind,
  TransactionRunResult,
} from "./transaction-status.js";
export { assertExhaustive } from "./exhaustive.js";
export { ERROR_CODES, isErrorCode } from "./error-codes.js";
export type { ErrorCode } from "./error-codes.js";
export { KNOWN_CHAINS, resolveChainConfig } from "./chain-config.js";
export type {
  HexAddress,
  ChainAddresses,
  ChainMetadata,
  ChainConfig,
  EnvSource,
} from "./chain-config.js";
export { DEFAULT_DECIMALS, parseAmount, formatAmount } from "./amount.js";
export type { Amount } from "./amount.js";

// F-1807 (Feature 18, T-1805): the real `TaskEscrow` event ABI
// fragments/decoders, moved here from `apps/api/src/modules/chain/*-event.ts`
// (T-1805's own prerequisite refactor — CLAUDE.md 原则 9, a pure move with
// zero logic changes) so the new `apps/indexer` package can genuinely reuse
// (not reimplement) the exact same decode functions `apps/api` already uses
// for synchronous on-chain verification.
export * from "./chain-events/task-funded-event.js";
export * from "./chain-events/task-accepted-event.js";
export * from "./chain-events/result-submitted-event.js";
export * from "./chain-events/result-approved-event.js";
export * from "./chain-events/delivery-timeout-claimed-event.js";
export * from "./chain-events/review-timeout-finalized-event.js";
export * from "./chain-events/dispute-opened-event.js";
export * from "./chain-events/dispute-resolved-event.js";
export * from "./chain-events/task-cancelled-event.js";

// Moved from `apps/api/src/db/test-support.ts` (T-1805's own prerequisite
// refactor) once `apps/indexer` became a second real consumer of the same
// "refuse to run destructive DB tests without a confirmed-safe
// TEST_DATABASE_URL" guard.
export { requireTestDatabaseUrl } from "./test-support.js";
