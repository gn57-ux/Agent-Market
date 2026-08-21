import { useCallback, useState } from "react";
import type { TransactionRunResult, TransactionStatus } from "@agent-market/domain";

export type VerifyOutcome =
  | { outcome: "confirmed" }
  | { outcome: "rpcUnavailable"; error: string }
  | { outcome: "rejected"; errorCode: string };

export interface UseTransactionFlowConfig {
  buildTx: () => Promise<{ hash: `0x${string}` }>;
  /**
   * Waits for the broadcast transaction to reach chain confirmation
   * (e.g. viem's `waitForTransactionReceipt`). Must not resolve before the
   * transaction is actually mined — `verify` below assumes it has been.
   */
  confirm: (txHash: `0x${string}`) => Promise<{ confirmations: number }>;
  verify: (txHash: `0x${string}`) => Promise<VerifyOutcome>;
}

export interface UseTransactionFlowResult {
  status: TransactionStatus;
  start: () => Promise<TransactionRunResult>;
  retry: () => Promise<TransactionRunResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Single-transaction lifecycle: sign -> broadcast -> confirm -> backend/event
 * verify -> success or failure. Deliberately does NOT orchestrate multiple
 * transactions (e.g. approve + business call) — consumers call this Hook
 * twice and sequence them explicitly using the returned TransactionRunResult
 * (see Feature 6/8's TaskCreatePage / AcceptConfirmContent).
 */
export function useTransactionFlow(config: UseTransactionFlowConfig): UseTransactionFlowResult {
  const [status, setStatus] = useState<TransactionStatus>({ kind: "idle" });

  // Re-attempts confirm() + verify() for an already-broadcast hash. Both
  // steps are safe to re-run: confirm() re-checking a receipt and verify()
  // re-checking backend state are both idempotent reads, not new writes.
  const confirmAndVerify = useCallback(
    async (txHash: `0x${string}`): Promise<TransactionRunResult> => {
      let confirmations: number;
      try {
        ({ confirmations } = await config.confirm(txHash));
      } catch (error) {
        const lastError = errorMessage(error);
        setStatus({ kind: "rpcRecoveryPending", txHash, lastError });
        return { outcome: "rpcRecoveryPending", txHash, lastError };
      }
      setStatus({ kind: "confirming", txHash, confirmations });

      setStatus({ kind: "verifying", txHash });
      let result: VerifyOutcome;
      try {
        result = await config.verify(txHash);
      } catch (error) {
        // A thrown/rejected verify() is treated as a transient failure
        // (network/backend outage), not a definitive business rejection —
        // the transaction may still be valid, so stay recoverable.
        const lastError = errorMessage(error);
        setStatus({ kind: "rpcRecoveryPending", txHash, lastError });
        return { outcome: "rpcRecoveryPending", txHash, lastError };
      }

      switch (result.outcome) {
        case "confirmed": {
          setStatus({ kind: "confirmed", txHash });
          return { outcome: "confirmed", txHash };
        }
        case "rpcUnavailable": {
          setStatus({ kind: "rpcRecoveryPending", txHash, lastError: result.error });
          return { outcome: "rpcRecoveryPending", txHash, lastError: result.error };
        }
        case "rejected": {
          setStatus({ kind: "failed", reason: result.errorCode });
          return { outcome: "failed", reason: result.errorCode };
        }
      }
    },
    [config],
  );

  const start = useCallback(async (): Promise<TransactionRunResult> => {
    setStatus({ kind: "awaitingSignature" });
    let hash: `0x${string}`;
    try {
      ({ hash } = await config.buildTx());
    } catch (error) {
      const reason = errorMessage(error);
      setStatus({ kind: "failed", reason });
      return { outcome: "failed", reason };
    }

    setStatus({ kind: "pending", txHash: hash });
    return confirmAndVerify(hash);
  }, [config, confirmAndVerify]);

  const retry = useCallback(async (): Promise<TransactionRunResult> => {
    if (status.kind === "rpcRecoveryPending") {
      return confirmAndVerify(status.txHash);
    }
    // failed (or any other state): start a fresh attempt from scratch.
    return start();
  }, [status, confirmAndVerify, start]);

  return { status, start, retry };
}
