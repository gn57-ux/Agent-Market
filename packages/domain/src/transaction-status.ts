export type TransactionStatus =
  | { kind: "idle" }
  | { kind: "awaitingSignature" }
  | { kind: "pending"; txHash: `0x${string}` }
  | { kind: "confirming"; txHash: `0x${string}`; confirmations: number }
  // Reached final confirmation count; waiting on the backend/event review
  // (e.g. Feature 6 funding-verifications) for its answer.
  | { kind: "verifying"; txHash: `0x${string}` }
  // The backend/RPC reported a transient failure (e.g. RPC_TEMPORARILY_UNAVAILABLE).
  // Recoverable — must NOT be treated as `failed`; polling may bring it
  // back to `verifying`/`confirmed`.
  | { kind: "rpcRecoveryPending"; txHash: `0x${string}`; lastError: string }
  | { kind: "confirmed"; txHash: `0x${string}` }
  // Only a genuine business/contract-level error reaches this state.
  | { kind: "failed"; reason: string };

export type TransactionStatusKind = TransactionStatus["kind"];

export type TransactionRunResult =
  | { outcome: "confirmed"; txHash: `0x${string}` }
  | { outcome: "rpcRecoveryPending"; txHash: `0x${string}`; lastError: string }
  | { outcome: "failed"; reason: string };
