import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTransactionFlow } from "./useTransactionFlow.js";

const TX_HASH = "0xabc" as const;

function delayed<T>(value: T, ms = 5): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("useTransactionFlow", () => {
  it("normal path: idle -> awaitingSignature -> pending -> confirming -> verifying -> confirmed, waiting for a delayed confirmation", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockImplementation(() => delayed({ confirmations: 3 }));
    const verify = vi.fn().mockResolvedValue({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));
    expect(result.current.status.kind).toBe("idle");

    let runResult;
    await act(async () => {
      runResult = await result.current.start();
    });

    expect(buildTx).toHaveBeenCalledOnce();
    // verify must only be called after confirm() has resolved (i.e. after
    // the delayed confirmation), not immediately upon broadcast.
    expect(confirm).toHaveBeenCalledWith(TX_HASH);
    expect(verify).toHaveBeenCalledWith(TX_HASH);
    expect(runResult).toEqual({ outcome: "confirmed", txHash: TX_HASH });
    expect(result.current.status).toEqual({ kind: "confirmed", txHash: TX_HASH });
  });

  it("RPC recovery path: verify reports rpcUnavailable -> status becomes rpcRecoveryPending, retry re-confirms and re-verifies and can then confirm", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockResolvedValue({ confirmations: 1 });
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "rpcUnavailable", error: "RPC_TEMPORARILY_UNAVAILABLE" })
      .mockResolvedValueOnce({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));

    let firstResult;
    await act(async () => {
      firstResult = await result.current.start();
    });
    expect(firstResult).toEqual({
      outcome: "rpcRecoveryPending",
      txHash: TX_HASH,
      lastError: "RPC_TEMPORARILY_UNAVAILABLE",
    });
    expect(result.current.status).toEqual({
      kind: "rpcRecoveryPending",
      txHash: TX_HASH,
      lastError: "RPC_TEMPORARILY_UNAVAILABLE",
    });

    let retryResult;
    await act(async () => {
      retryResult = await result.current.retry();
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(retryResult).toEqual({ outcome: "confirmed", txHash: TX_HASH });
    expect(result.current.status).toEqual({ kind: "confirmed", txHash: TX_HASH });
  });

  it("a rejected/throwing verify() is treated as recoverable, not a hard failure", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockResolvedValue({ confirmations: 1 });
    const verify = vi.fn().mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));
    let runResult;
    await act(async () => {
      runResult = await result.current.start();
    });

    expect(runResult).toEqual({
      outcome: "rpcRecoveryPending",
      txHash: TX_HASH,
      lastError: "network error",
    });
    expect(result.current.status.kind).toBe("rpcRecoveryPending");
  });

  it("a throwing confirm() is also treated as recoverable (transaction was broadcast, receipt just couldn't be observed)", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockRejectedValue(new Error("RPC timeout"));
    const verify = vi.fn();

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));
    let runResult;
    await act(async () => {
      runResult = await result.current.start();
    });

    expect(verify).not.toHaveBeenCalled();
    expect(runResult).toEqual({
      outcome: "rpcRecoveryPending",
      txHash: TX_HASH,
      lastError: "RPC timeout",
    });
    expect(result.current.status.kind).toBe("rpcRecoveryPending");
  });

  it("rpcRecoveryPending never auto-transitions to failed on its own", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockResolvedValue({ confirmations: 1 });
    const verify = vi
      .fn()
      .mockResolvedValue({ outcome: "rpcUnavailable", error: "RPC_TEMPORARILY_UNAVAILABLE" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status.kind).toBe("rpcRecoveryPending");

    // Wait a tick without calling retry — nothing should push it to failed by itself.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.status.kind).toBe("rpcRecoveryPending");
    expect(result.current.status.kind).not.toBe("failed");
  });

  it("failed -> retry -> pending: a business rejection can be retried as a fresh attempt", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockResolvedValue({ confirmations: 1 });
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "rejected", errorCode: "TASK_STATE_CONFLICT" })
      .mockResolvedValueOnce({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toEqual({ kind: "failed", reason: "TASK_STATE_CONFLICT" });

    let retryResult;
    await act(async () => {
      retryResult = await result.current.retry();
    });
    // retry() from `failed` re-runs buildTx from scratch (a fresh attempt).
    expect(buildTx).toHaveBeenCalledTimes(2);
    expect(retryResult).toEqual({ outcome: "confirmed", txHash: TX_HASH });
    await waitFor(() => expect(result.current.status.kind).toBe("confirmed"));
  });

  it("confirming is actually observable while awaiting confirm(), not skipped by batching", async () => {
    let resolveConfirm!: (value: { confirmations: number }) => void;
    const confirmPromise = new Promise<{ confirmations: number }>((resolve) => {
      resolveConfirm = resolve;
    });
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockReturnValue(confirmPromise);
    const verify = vi.fn().mockResolvedValue({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));

    let startPromise!: Promise<unknown>;
    await act(async () => {
      startPromise = result.current.start();
      // Yield one microtask so buildTx resolves and confirmAndVerify sets
      // "confirming" — without yet resolving confirm() itself.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status.kind).toBe("confirming");
    expect(verify).not.toHaveBeenCalled();

    await act(async () => {
      resolveConfirm({ confirmations: 2 });
      await startPromise;
    });
    expect(result.current.status).toEqual({ kind: "confirmed", txHash: TX_HASH });
  });

  it("retry captured before a concurrent start() reads live state via a ref, not a stale closure, and recovers instead of re-broadcasting", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const confirm = vi.fn().mockResolvedValue({ confirmations: 1 });
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "rpcUnavailable", error: "RPC_TEMPORARILY_UNAVAILABLE" })
      .mockResolvedValueOnce({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));

    // Capture `retry` while status is still "idle" — a stale closure would
    // see status.kind === "idle" forever and always fall through to start().
    const staleRetry = result.current.retry;

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status.kind).toBe("rpcRecoveryPending");

    let retryResult;
    await act(async () => {
      retryResult = await staleRetry();
    });

    // A correct implementation recovers the existing tx (no second buildTx
    // call); the stale-closure bug would call buildTx again here.
    expect(buildTx).toHaveBeenCalledTimes(1);
    expect(retryResult).toEqual({ outcome: "confirmed", txHash: TX_HASH });
  });

  it("buildTx throwing maps to failed with the error message as reason", async () => {
    const buildTx = vi.fn().mockRejectedValue(new Error("user rejected signature"));
    const confirm = vi.fn();
    const verify = vi.fn();

    const { result } = renderHook(() => useTransactionFlow({ buildTx, confirm, verify }));
    let runResult;
    await act(async () => {
      runResult = await result.current.start();
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(runResult).toEqual({ outcome: "failed", reason: "user rejected signature" });
    expect(result.current.status).toEqual({ kind: "failed", reason: "user rejected signature" });
  });
});
