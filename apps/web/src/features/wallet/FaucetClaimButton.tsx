import { useEffect, useState } from "react";
import { formatAmount } from "@agent-market/domain";
import { useWallet } from "./WalletProvider.js";
import { TransactionStatusView } from "../../shared/components/TransactionStatus.js";
import { useTransactionFlow } from "../../shared/tx-flow/useTransactionFlow.js";

const YD_FAUCET_ABI = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "claimAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "cooldownPeriod",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lastClaimedAt",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface FaucetState {
  claimAmount: bigint;
  cooldownPeriod: bigint;
  lastClaimedAt: bigint;
}

export interface FaucetClaimButtonProps {
  /** Called once a claim reaches on-chain confirmation — lets a caller with
   * its own, independent balance read (e.g. TaskCreatePage's funding-step
   * precheck, which does NOT go through `wallet.connection.ydBalance`) know
   * it should re-read too. N4 review (P2): `wallet.refreshBalance()` alone
   * only updates WalletProvider's own balance state; a consumer with a
   * separate `balanceOf` read had no way to learn a claim just happened,
   * and stayed stuck showing "余额不足" until a full page refresh. */
  onClaimed?: () => void;
}

/** Task B: single, explicit "领取测试 YD" entry point. Reads the faucet's own
 * on-chain `claimAmount`/`cooldownPeriod`/`lastClaimedAt(address)` — never
 * hardcodes them — so this stays correct if a deployment ever configures the
 * faucet differently (`YDFaucet.sol` is the sole owner of that knowledge).
 *
 * Gated on `wallet.chainConfig.isTestnet` (see chain-config.ts's doc comment
 * on that field) — "只用于本地 Hardhat/允许的测试网络" is enforced by simply
 * not rendering anything at all on a network that isn't one, rather than
 * rendering a disabled/hidden-but-present button a curious user could still
 * find a way to trigger.
 */
export function FaucetClaimButton({ onClaimed }: FaucetClaimButtonProps = {}) {
  const wallet = useWallet();
  const address = wallet.address;
  const connected = wallet.connection.status === "connected";
  const [faucet, setFaucet] = useState<
    { status: "loading" } | { status: "ready"; data: FaucetState } | { status: "error" }
  >({ status: "loading" });

  async function readFaucetState(): Promise<FaucetState> {
    const publicClient = wallet.getPublicClient();
    if (!address) throw new Error("未连接钱包。");
    const [claimAmount, cooldownPeriod, lastClaimedAt] = await Promise.all([
      publicClient.readContract({
        address: wallet.chainConfig.addresses.ydFaucet,
        abi: YD_FAUCET_ABI,
        functionName: "claimAmount",
      }),
      publicClient.readContract({
        address: wallet.chainConfig.addresses.ydFaucet,
        abi: YD_FAUCET_ABI,
        functionName: "cooldownPeriod",
      }),
      publicClient.readContract({
        address: wallet.chainConfig.addresses.ydFaucet,
        abi: YD_FAUCET_ABI,
        functionName: "lastClaimedAt",
        args: [address],
      }),
    ]);
    return { claimAmount, cooldownPeriod, lastClaimedAt };
  }

  useEffect(() => {
    if (!connected || !wallet.isCorrectNetwork || !wallet.chainConfig.isTestnet) return;
    let ignore = false;
    setFaucet({ status: "loading" });
    void readFaucetState()
      .then((data) => {
        if (!ignore) setFaucet({ status: "ready", data });
      })
      .catch(() => {
        if (!ignore) setFaucet({ status: "error" });
      });
    return () => {
      ignore = true;
    };
    // `wallet.identityGeneration` re-reads on account/network switch, same
    // convention as AcceptConfirmContent's balance/allowance effect.
  }, [connected, wallet.isCorrectNetwork, wallet.chainConfig, wallet.identityGeneration]);

  // N4 review (P2): `nowSeconds`/`onCooldown` below are only recomputed
  // when this component re-renders for some OTHER reason — with nothing
  // driving a re-render purely from time passing, the claim button stayed
  // disabled with a frozen countdown forever past the real on-chain
  // cooldown end, requiring a full page refresh. Ticks a plain counter once
  // a second WHILE actually on cooldown (computed from `faucet` state
  // directly, not the render-body consts below, since those don't exist
  // yet at the point this hook must be declared) and stops itself once the
  // cooldown has elapsed — not an unconditional interval that would keep
  // firing forever after.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (faucet.status !== "ready" || faucet.data.lastClaimedAt === 0n) return;
    const nextClaimAtSeconds = Number(faucet.data.lastClaimedAt + faucet.data.cooldownPeriod);
    if (nextClaimAtSeconds <= Math.floor(Date.now() / 1000)) return;
    const interval = setInterval(() => {
      forceTick((tick) => tick + 1);
      if (nextClaimAtSeconds <= Math.floor(Date.now() / 1000)) {
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [faucet]);

  const claimFlow = useTransactionFlow({
    buildTx: async () => {
      const walletClient = wallet.getWalletClient();
      if (!address) throw new Error("未连接钱包。");
      const hash = await walletClient.writeContract({
        account: address,
        chain: null,
        address: wallet.chainConfig.addresses.ydFaucet,
        abi: YD_FAUCET_ABI,
        functionName: "claim",
        args: [],
      });
      return { hash };
    },
    confirm: async (txHash) => {
      const publicClient = wallet.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new Error("领取交易执行失败（已回滚）。");
      }
      return { confirmations: 1 };
    },
    // No backend state to reconcile — a faucet claim is purely on-chain, so
    // "confirmed" IS "verified" here (unlike task funding/acceptance, which
    // this hook's `verify` step exists to reconcile against the API).
    verify: async () => ({ outcome: "confirmed" }),
  });

  if (!connected || !wallet.isCorrectNetwork || !wallet.chainConfig.isTestnet) {
    return null;
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const readyData = faucet.status === "ready" ? faucet.data : undefined;
  const nextClaimAt =
    readyData && readyData.lastClaimedAt > 0n
      ? readyData.lastClaimedAt + readyData.cooldownPeriod
      : 0n;
  const onCooldown = readyData !== undefined && nextClaimAt > nowSeconds;
  const remainingSeconds = onCooldown ? Number(nextClaimAt - nowSeconds) : 0;
  const claiming = claimFlow.status.kind !== "idle" && claimFlow.status.kind !== "confirmed";

  async function handleClaim() {
    const result = await claimFlow.start();
    if (result.outcome === "confirmed") {
      // Task B: "领取后余额必须自动刷新" — the single existing balance-read
      // trigger WalletProvider already owns, not a second copy of "how to
      // read balanceOf" here.
      wallet.refreshBalance();
      onClaimed?.();
      void readFaucetState()
        .then((data) => setFaucet({ status: "ready", data }))
        .catch(() => undefined);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-caption">
      {faucet.status === "ready" && (
        <button
          type="button"
          onClick={() => void handleClaim()}
          disabled={claiming || onCooldown}
          className="rounded-control border border-action-blue px-3 py-1 text-action-blue transition-opacity hover:bg-action-blue/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {onCooldown
            ? `领取测试 YD（${formatCooldown(remainingSeconds)}后可再次领取）`
            : `领取测试 YD（${formatAmount(readyData?.claimAmount ?? 0n, 18)} YD）`}
        </button>
      )}
      {faucet.status === "error" && (
        <span role="alert" className="text-warning">
          读取测试币领取信息失败，请刷新页面重试。
        </span>
      )}
      {claiming && <TransactionStatusView status={claimFlow.status} />}
      {claimFlow.status.kind === "failed" && (
        <span role="alert" className="text-warning">
          领取失败：{claimFlow.status.reason}
        </span>
      )}
      {claimFlow.status.kind === "rpcRecoveryPending" && (
        <button
          type="button"
          onClick={() => void claimFlow.retry()}
          className="rounded-control border border-warning px-2.5 py-1 text-warning hover:bg-warning/10"
        >
          重试领取
        </button>
      )}
    </div>
  );
}

function formatCooldown(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0 秒";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}
