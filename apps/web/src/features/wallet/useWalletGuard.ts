import { useCallback } from "react";
import { useWallet } from "./WalletProvider.js";

export type WalletGuardResult<T> = { allowed: true; value: T } | { allowed: false; reason: string };

export interface WalletGuard {
  canTransact: boolean;
  blockedReason: string | undefined;
  runGuarded: <T>(action: () => T) => WalletGuardResult<T>;
}

/** Central transaction eligibility rule; callers cannot accidentally execute a blocked action. */
export function useWalletGuard(): WalletGuard {
  const { address, isCorrectNetwork, chainConfig } = useWallet();
  const blockedReason = !address
    ? "请先连接 MetaMask 钱包，再执行此操作。"
    : !isCorrectNetwork
      ? `当前网络不正确。请先切换到 ${chainConfig.name}，再提交交易。`
      : undefined;

  const runGuarded = useCallback(
    <T>(action: () => T): WalletGuardResult<T> => {
      if (blockedReason) return { allowed: false, reason: blockedReason };
      return { allowed: true, value: action() };
    },
    [blockedReason],
  );

  return { canTransact: blockedReason === undefined, blockedReason, runGuarded };
}
