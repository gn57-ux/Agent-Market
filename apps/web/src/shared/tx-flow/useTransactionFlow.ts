import { useCallback, useRef, useState } from "react";
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
  // Mirrors `status` but is read by retry() instead of the closed-over
  // `status` value, so a `retry` reference captured before a concurrent
  // `start()` call sees the up-to-date state instead of stale pre-start
  // data (which could otherwise cause retry() to re-broadcast a second
  // transaction instead of recovering the first one).
  const statusRef = useRef<TransactionStatus>(status);
  const setStatusTracked = useCallback((next: TransactionStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  // Re-attempts confirm() + verify() for an already-broadcast hash. Both
  // steps are safe to re-run: confirm() re-checking a receipt and verify()
  // re-checking backend state are both idempotent reads, not new writes.
  const confirmAndVerify = useCallback(
    async (txHash: `0x${string}`): Promise<TransactionRunResult> => {
      // Set BEFORE awaiting confirm(), so "confirming" is the state actually
      // observed while waiting for chain confirmation — not skipped over by
      // React batching two post-await setState calls into one render.
      setStatusTracked({ kind: "confirming", txHash, confirmations: 0 });

      let confirmations: number;
      try {
        ({ confirmations } = await config.confirm(txHash));
      } catch (error) {
        const lastError = errorMessage(error);
        setStatusTracked({ kind: "rpcRecoveryPending", txHash, lastError });
        return { outcome: "rpcRecoveryPending", txHash, lastError };
      }
      setStatusTracked({ kind: "confirming", txHash, confirmations });

      setStatusTracked({ kind: "verifying", txHash });
      let result: VerifyOutcome;
      try {
        result = await config.verify(txHash);
      } catch (error) {
        // A thrown/rejected verify() is treated as a transient failure
        // (network/backend outage), not a definitive business rejection —
        // the transaction may still be valid, so stay recoverable.
        const lastError = errorMessage(error);
        setStatusTracked({ kind: "rpcRecoveryPending", txHash, lastError });
        return { outcome: "rpcRecoveryPending", txHash, lastError };
      }

      switch (result.outcome) {
        case "confirmed": {
          setStatusTracked({ kind: "confirmed", txHash });
          return { outcome: "confirmed", txHash };
        }
        case "rpcUnavailable": {
          setStatusTracked({ kind: "rpcRecoveryPending", txHash, lastError: result.error });
          return { outcome: "rpcRecoveryPending", txHash, lastError: result.error };
        }
        case "rejected": {
          setStatusTracked({ kind: "failed", reason: result.errorCode });
          return { outcome: "failed", reason: result.errorCode };
        }
      }
    },
    [config, setStatusTracked],
  );

  const start = useCallback(async (): Promise<TransactionRunResult> => {
    setStatusTracked({ kind: "awaitingSignature" });
    let hash: `0x${string}`;
    try {
      ({ hash } = await config.buildTx());
    } catch (error) {
      const reason = errorMessage(error);
      setStatusTracked({ kind: "failed", reason });
      return { outcome: "failed", reason };
    }

    setStatusTracked({ kind: "pending", txHash: hash });
    // "pending" and the start of "confirming" are both set synchronously
    // back-to-back here (no real async gate between them — broadcast
    // immediately begins the confirmation wait), so they may commit as a
    // single React render. That's fine: "pending" isn't waiting on anything
    // itself, so there's no correctness reason to force it onto its own
    // render (unlike "confirming", which genuinely waits on confirm() and
    // must be observable — see below). Adding an artificial delay here
    // purely for state-isolation in tests would be complexity with no
    // production benefit.
    return confirmAndVerify(hash);
  }, [config, confirmAndVerify, setStatusTracked]);

  const retry = useCallback(async (): Promise<TransactionRunResult> => {
    const current = statusRef.current;
    if (current.kind === "rpcRecoveryPending") {
      return confirmAndVerify(current.txHash);
    }
    if (current.kind === "failed") {
      return start();
    }
    // idle / awaitingSignature / pending / confirming / verifying / confirmed:
    // retry() is only meaningful once there's something to recover from
    // (rpcRecoveryPending) or a fresh attempt to make (failed). Calling it
    // from any other state is a caller bug — reject loudly instead of
    // silently re-signing/re-broadcasting a transaction.
    throw new Error(
      `retry() is only valid from 'rpcRecoveryPending' or 'failed', current status: '${current.kind}'`,
    );
  }, [confirmAndVerify, start]);

  return { status, start, retry };
}
