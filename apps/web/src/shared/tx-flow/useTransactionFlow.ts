import { useCallback, useRef, useState } from "react";
import type { TransactionRunResult, TransactionStatus } from "@agent-market/domain";

export type VerifyOutcome =
  | { outcome: "confirmed" }
  | { outcome: "rpcUnavailable"; error: string }
  | { outcome: "rejected"; errorCode: string };

export interface UseTransactionFlowConfig {
  buildTx: () => Promise<{ hash: `0x${string}` }>;
  verify: (txHash: `0x${string}`) => Promise<VerifyOutcome>;
}

export interface UseTransactionFlowResult {
  status: TransactionStatus;
  start: () => Promise<TransactionRunResult>;
  retry: () => Promise<TransactionRunResult>;
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
  const lastTxHashRef = useRef<`0x${string}` | undefined>(undefined);

  const runVerification = useCallback(
    async (txHash: `0x${string}`): Promise<TransactionRunResult> => {
      setStatus({ kind: "verifying", txHash });
      const result = await config.verify(txHash);

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
      const reason = error instanceof Error ? error.message : String(error);
      setStatus({ kind: "failed", reason });
      return { outcome: "failed", reason };
    }

    lastTxHashRef.current = hash;
    setStatus({ kind: "pending", txHash: hash });
    // Transient state representing "broadcast, awaiting confirmation" before
    // the backend/event check; this Hook's minimal contract (buildTx/verify)
    // doesn't report incremental confirmation counts.
    setStatus({ kind: "confirming", txHash: hash, confirmations: 0 });

    return runVerification(hash);
  }, [config, runVerification]);

  const retry = useCallback(async (): Promise<TransactionRunResult> => {
    if (status.kind === "rpcRecoveryPending") {
      return runVerification(status.txHash);
    }
    // failed (or any other state): start a fresh attempt from scratch.
    return start();
  }, [status, runVerification, start]);

  return { status, start, retry };
}
