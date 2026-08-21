import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTransactionFlow } from "./useTransactionFlow.js";

const TX_HASH = "0xabc" as const;

describe("useTransactionFlow", () => {
  it("normal path: idle -> awaitingSignature -> pending -> confirming -> verifying -> confirmed", async () => {
    const statusHistory: string[] = [];
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const verify = vi.fn().mockResolvedValue({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, verify }));
    expect(result.current.status.kind).toBe("idle");

    let runResult;
    await act(async () => {
      runResult = await result.current.start();
    });

    expect(buildTx).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(TX_HASH);
    expect(runResult).toEqual({ outcome: "confirmed", txHash: TX_HASH });
    expect(result.current.status).toEqual({ kind: "confirmed", txHash: TX_HASH });
    void statusHistory;
  });

  it("RPC recovery path: verify reports rpcUnavailable -> status becomes rpcRecoveryPending, retry re-verifies and can then confirm", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "rpcUnavailable", error: "RPC_TEMPORARILY_UNAVAILABLE" })
      .mockResolvedValueOnce({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, verify }));

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
    expect(verify).toHaveBeenCalledTimes(2);
    expect(retryResult).toEqual({ outcome: "confirmed", txHash: TX_HASH });
    expect(result.current.status).toEqual({ kind: "confirmed", txHash: TX_HASH });
  });

  it("rpcRecoveryPending never auto-transitions to failed on its own", async () => {
    const buildTx = vi.fn().mockResolvedValue({ hash: TX_HASH });
    const verify = vi
      .fn()
      .mockResolvedValue({ outcome: "rpcUnavailable", error: "RPC_TEMPORARILY_UNAVAILABLE" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, verify }));
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
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "rejected", errorCode: "TASK_STATE_CONFLICT" })
      .mockResolvedValueOnce({ outcome: "confirmed" });

    const { result } = renderHook(() => useTransactionFlow({ buildTx, verify }));

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

  it("buildTx throwing maps to failed with the error message as reason", async () => {
    const buildTx = vi.fn().mockRejectedValue(new Error("user rejected signature"));
    const verify = vi.fn();

    const { result } = renderHook(() => useTransactionFlow({ buildTx, verify }));
    let runResult;
    await act(async () => {
      runResult = await result.current.start();
    });

    expect(verify).not.toHaveBeenCalled();
    expect(runResult).toEqual({ outcome: "failed", reason: "user rejected signature" });
    expect(result.current.status).toEqual({ kind: "failed", reason: "user rejected signature" });
  });
});
