import {
  formatAmount,
  KNOWN_CHAINS,
  resolveChainConfig,
  type Amount,
  type ChainConfig,
  type HexAddress,
} from "@agent-market/domain";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createPublicClient, createWalletClient, custom } from "viem";
import { WalletButton } from "../../shared/components/index.js";

const YD_TOKEN_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "decimals", type: "uint8" }],
  },
] as const;

interface InjectedWalletProvider {
  request(request: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: InjectedWalletProvider;
  }
}

export type WalletBalance =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "ready"; amount: Amount; decimals: number; formatted: string }
  | { status: "error"; message: string };

export type WalletConnection =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      address: HexAddress;
      chainId: number;
      ydBalance: WalletBalance;
    };

export interface WalletContextValue {
  connection: WalletConnection;
  address: HexAddress | undefined;
  chainId: number | undefined;
  chainConfig: ChainConfig;
  isCorrectNetwork: boolean;
  errorMessage: string | undefined;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
}

export interface WalletProviderProps {
  children: ReactNode;
  /** A test/deployment seam; normal application callers use the Vite environment. */
  chainConfig?: ChainConfig;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function resolveFrontendChainConfig(): ChainConfig {
  return resolveChainConfig({
    CHAIN_ID: import.meta.env.VITE_CHAIN_ID,
    TASK_ESCROW_ADDRESS: import.meta.env.VITE_TASK_ESCROW_ADDRESS,
    YD_TOKEN_ADDRESS: import.meta.env.VITE_YD_TOKEN_ADDRESS,
    YD_FAUCET_ADDRESS: import.meta.env.VITE_YD_FAUCET_ADDRESS,
  });
}

function providerErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

function walletErrorMessage(error: unknown, operation: "connect" | "switch"): string {
  if (providerErrorCode(error) === 4001) {
    return operation === "connect"
      ? "你已取消钱包连接；需要继续时请再次点击“连接钱包”。"
      : "你已取消网络切换；请切换到目标网络后再提交交易。";
  }
  return operation === "connect"
    ? "钱包连接失败。请确认 MetaMask 已解锁，然后重试。"
    : "网络切换失败。请在 MetaMask 中手动切换到目标网络后重试。";
}

function requireInjectedProvider(): InjectedWalletProvider {
  const provider = typeof window === "undefined" ? undefined : window.ethereum;
  if (!provider) {
    throw new Error("未检测到 MetaMask。请先安装并启用 MetaMask 浏览器扩展，然后重试。");
  }
  return provider;
}

async function readYdBalance(
  provider: InjectedWalletProvider,
  chainConfig: ChainConfig,
  address: HexAddress,
): Promise<WalletBalance> {
  try {
    const publicClient = createPublicClient({ transport: custom(provider) });
    const [amount, decimals] = await Promise.all([
      publicClient.readContract({
        address: chainConfig.addresses.ydToken,
        abi: YD_TOKEN_ABI,
        functionName: "balanceOf",
        args: [address],
      }),
      publicClient.readContract({
        address: chainConfig.addresses.ydToken,
        abi: YD_TOKEN_ABI,
        functionName: "decimals",
      }),
    ]);
    return { status: "ready", amount, decimals, formatted: formatAmount(amount, decimals) };
  } catch {
    return {
      status: "error",
      message: "YD 余额读取失败。请检查钱包网络与 RPC 连接后重试。",
    };
  }
}

export function WalletProvider({ children, chainConfig: configuredChain }: WalletProviderProps) {
  const chainConfig = useMemo(
    () => configuredChain ?? resolveFrontendChainConfig(),
    [configuredChain],
  );
  const [connection, setConnection] = useState<WalletConnection>({ status: "disconnected" });
  const [errorMessage, setErrorMessage] = useState<string>();

  const connect = useCallback(async () => {
    setConnection({ status: "connecting" });
    setErrorMessage(undefined);
    try {
      const provider = requireInjectedProvider();
      const walletClient = createWalletClient({ transport: custom(provider) });
      const [address] = await walletClient.requestAddresses();
      if (!address) {
        throw new Error("MetaMask 未返回可用账户。请在钱包中选择一个账户后重试。");
      }
      const chainId = await walletClient.getChainId();
      const needsNetworkSwitch = chainId !== chainConfig.chainId;
      setConnection({
        status: "connected",
        address,
        chainId,
        ydBalance: needsNetworkSwitch ? { status: "unavailable" } : { status: "loading" },
      });
      if (!needsNetworkSwitch) {
        const ydBalance = await readYdBalance(provider, chainConfig, address);
        setConnection((current) =>
          current.status === "connected" &&
          current.address === address &&
          current.chainId === chainId
            ? { ...current, ydBalance }
            : current,
        );
      }
    } catch (error) {
      setConnection({ status: "disconnected" });
      setErrorMessage(
        error instanceof Error && error.message.startsWith("未检测到")
          ? error.message
          : walletErrorMessage(error, "connect"),
      );
    }
  }, [chainConfig]);

  const disconnect = useCallback(() => {
    setConnection({ status: "disconnected" });
    setErrorMessage(undefined);
  }, []);

  const switchNetwork = useCallback(async () => {
    if (connection.status !== "connected") {
      setErrorMessage("请先连接 MetaMask，再切换网络。");
      return;
    }
    setErrorMessage(undefined);
    try {
      const provider = requireInjectedProvider();
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${chainConfig.chainId.toString(16)}` }],
      });
      const ydBalance = await readYdBalance(provider, chainConfig, connection.address);
      setConnection({
        status: "connected",
        address: connection.address,
        chainId: chainConfig.chainId,
        ydBalance,
      });
    } catch (error) {
      setErrorMessage(walletErrorMessage(error, "switch"));
    }
  }, [chainConfig, connection]);

  const address = connection.status === "connected" ? connection.address : undefined;
  const chainId = connection.status === "connected" ? connection.chainId : undefined;
  const value = useMemo<WalletContextValue>(
    () => ({
      connection,
      address,
      chainId,
      chainConfig,
      isCorrectNetwork: chainId === chainConfig.chainId,
      errorMessage,
      connect,
      disconnect,
      switchNetwork,
    }),
    [address, chainConfig, chainId, connect, connection, disconnect, errorMessage, switchNetwork],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useWallet 必须在 WalletProvider 内使用。");
  return wallet;
}

function currentNetworkName(chainId: number): string {
  return KNOWN_CHAINS[chainId]?.name ?? `Chain ${chainId}`;
}

/** Global wallet UI. The provider owns behavior; this view reuses the shared presentational button. */
export function WalletConnectionStatus() {
  const wallet = useWallet();
  const connected = wallet.connection.status === "connected" ? wallet.connection : undefined;

  return (
    <section aria-label="钱包状态">
      <WalletButton
        address={wallet.address}
        onConnect={() => void wallet.connect()}
        onDisconnect={wallet.disconnect}
      />
      {wallet.connection.status === "connecting" && <span>正在连接钱包…</span>}
      {connected && <span>当前网络：{currentNetworkName(connected.chainId)}</span>}
      {connected?.ydBalance.status === "ready" && (
        <span>YD 余额：{connected.ydBalance.formatted} YD</span>
      )}
      {connected?.ydBalance.status === "loading" && wallet.isCorrectNetwork && (
        <span>正在读取 YD 余额…</span>
      )}
      {connected?.ydBalance.status === "error" && (
        <span role="alert">{connected.ydBalance.message}</span>
      )}
      {connected && !wallet.isCorrectNetwork && (
        <div role="alert">
          当前网络不正确。请切换到 {wallet.chainConfig.name} 后再提交交易。
          <button type="button" onClick={() => void wallet.switchNetwork()}>
            切换网络
          </button>
        </div>
      )}
      {wallet.errorMessage && <div role="alert">{wallet.errorMessage}</div>}
    </section>
  );
}
