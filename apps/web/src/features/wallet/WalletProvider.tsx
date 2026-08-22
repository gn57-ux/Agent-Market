import {
  formatAmount,
  KNOWN_CHAINS,
  resolveChainConfig,
  type Amount,
  type ChainConfig,
  type HexAddress,
} from "@agent-market/domain";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
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

/** MetaMask (and any EIP-1193-compliant provider) implements the optional
 * `on`/`removeListener` event pair for `accountsChanged`/`chainChanged` —
 * fired when the user switches account or network *inside the wallet UI*,
 * bypassing this app's own connect/switch buttons entirely. F-402 requires
 * listening for these so the app's state can't silently go stale relative
 * to the wallet's real state. */
interface InjectedWalletProvider {
  request(request: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(eventName: "accountsChanged" | "chainChanged", listener: (payload: unknown) => void): void;
  removeListener?(
    eventName: "accountsChanged" | "chainChanged",
    listener: (payload: unknown) => void,
  ): void;
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

class ActionableWalletError extends Error {}

type ChainConfigResolution = { ok: true; config: ChainConfig } | { ok: false; message: string };

/** Never throws: a misconfigured deployment (e.g. the zero-address
 * placeholders shipped in .env.example) must surface as a readable Chinese
 * message, not crash the whole app before any UI — including the wallet
 * error UI itself — has a chance to render. */
function resolveFrontendChainConfig(): ChainConfigResolution {
  try {
    const config = resolveChainConfig({
      CHAIN_ID: import.meta.env.VITE_CHAIN_ID,
      TASK_ESCROW_ADDRESS: import.meta.env.VITE_TASK_ESCROW_ADDRESS,
      YD_TOKEN_ADDRESS: import.meta.env.VITE_YD_TOKEN_ADDRESS,
      YD_FAUCET_ADDRESS: import.meta.env.VITE_YD_FAUCET_ADDRESS,
    });
    return { ok: true, config };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `应用尚未正确配置链上参数（${detail}）。请检查 .env 中的 VITE_CHAIN_ID / VITE_TASK_ESCROW_ADDRESS / VITE_YD_TOKEN_ADDRESS / VITE_YD_FAUCET_ADDRESS 是否已填入真实部署地址。`,
    };
  }
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

/** MetaMask returns error code 4902 from wallet_switchEthereumChain when the
 * target chain was never added to the wallet (common for a fresh install
 * against the local Hardhat network). Falls back to wallet_addEthereumChain,
 * which both registers and switches to it in one wallet-side confirmation. */
async function addTargetChainToWallet(
  provider: InjectedWalletProvider,
  chainConfig: ChainConfig,
): Promise<void> {
  const rpcUrl = import.meta.env.VITE_WALLET_RPC_URL;
  if (!rpcUrl) {
    throw new ActionableWalletError(
      "未配置 VITE_WALLET_RPC_URL，无法自动添加目标网络；请在 MetaMask 中手动添加后重试。",
    );
  }
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: `0x${chainConfig.chainId.toString(16)}`,
        chainName: chainConfig.name,
        rpcUrls: [rpcUrl],
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      },
    ],
  });
}

function requireInjectedProvider(): InjectedWalletProvider {
  const provider = typeof window === "undefined" ? undefined : window.ethereum;
  if (!provider) {
    throw new ActionableWalletError(
      "未检测到 MetaMask。请先安装并启用 MetaMask 浏览器扩展，然后重试。",
    );
  }
  return provider;
}

async function readActiveChainId(provider: InjectedWalletProvider): Promise<number> {
  const result = await provider.request({ method: "eth_chainId" });
  if (typeof result !== "string") {
    throw new ActionableWalletError("无法读取钱包当前网络，请重试。");
  }
  return Number.parseInt(result, 16);
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

/**
 * Re-reads the YD balance and applies it only if the connection identity
 * (address + chainId) hasn't moved on since the read started — the same
 * staleness rule `useVersionedAsync` (requestVersion.ts) generalizes for
 * Feature 5-10 consumers, inlined here because this helper runs inside the
 * same component that defines WalletContext (it cannot consume its own
 * not-yet-provided context via `useWallet`).
 */
function refreshYdBalance(
  setConnection: Dispatch<SetStateAction<WalletConnection>>,
  provider: InjectedWalletProvider,
  chainConfig: ChainConfig,
  address: HexAddress,
  chainId: number,
): void {
  void readYdBalance(provider, chainConfig, address).then((ydBalance) => {
    setConnection((current) =>
      current.status === "connected" && current.address === address && current.chainId === chainId
        ? { ...current, ydBalance }
        : current,
    );
  });
}

/** Resolves chain configuration and only then mounts the stateful wallet
 * provider — keeps the "hooks always run in the same order" rule intact
 * (no hook runs conditionally; the early-return path below has none). */
export function WalletProvider({ children, chainConfig: configuredChain }: WalletProviderProps) {
  const resolution = useMemo<ChainConfigResolution>(
    () => (configuredChain ? { ok: true, config: configuredChain } : resolveFrontendChainConfig()),
    [configuredChain],
  );

  if (!resolution.ok) {
    return <div role="alert">{resolution.message}</div>;
  }

  return (
    <ConnectedWalletProvider chainConfig={resolution.config}>{children}</ConnectedWalletProvider>
  );
}

interface ConnectedWalletProviderProps {
  children: ReactNode;
  chainConfig: ChainConfig;
}

function ConnectedWalletProvider({ children, chainConfig }: ConnectedWalletProviderProps) {
  const [connection, setConnection] = useState<WalletConnection>({ status: "disconnected" });
  const [errorMessage, setErrorMessage] = useState<string>();
  // Lets the wallet-event effect below (which intentionally only
  // re-subscribes when chainConfig changes, not on every connection change)
  // read the latest connection without re-registering EIP-1193 listeners.
  const connectionRef = useRef(connection);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  const connect = useCallback(async () => {
    setConnection({ status: "connecting" });
    setErrorMessage(undefined);
    try {
      const provider = requireInjectedProvider();
      const walletClient = createWalletClient({ transport: custom(provider) });
      const [address] = await walletClient.requestAddresses();
      if (!address) {
        throw new ActionableWalletError("MetaMask 未返回可用账户。请在钱包中选择一个账户后重试。");
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
        refreshYdBalance(setConnection, provider, chainConfig, address, chainId);
      }
    } catch (error) {
      setConnection({ status: "disconnected" });
      setErrorMessage(
        error instanceof ActionableWalletError
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
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${chainConfig.chainId.toString(16)}` }],
        });
      } catch (switchError) {
        if (providerErrorCode(switchError) !== 4902) throw switchError;
        // Target chain isn't registered in the wallet yet (fresh MetaMask
        // install against local Hardhat, most commonly) — register it.
        // EIP-3085 does not guarantee wallet_addEthereumChain also makes the
        // new chain active, so this alone is not enough to consider the
        // switch done — verify the actual active chain below regardless of
        // which branch ran.
        await addTargetChainToWallet(provider, chainConfig);
      }
      const activeChainId = await readActiveChainId(provider);
      if (activeChainId !== chainConfig.chainId) {
        throw new ActionableWalletError(
          `网络已添加，但钱包仍停留在原网络。请在 MetaMask 中手动切换到 ${chainConfig.name} 后重试。`,
        );
      }
      const switchedAddress = connection.address;
      // Guarded, not an unconditional overwrite: if the user disconnected
      // (or switched account) while this switch/add-chain round trip was in
      // flight, this must not resurrect a stale "connected" state.
      setConnection((current) =>
        current.status === "connected" && current.address === switchedAddress
          ? {
              status: "connected",
              address: switchedAddress,
              chainId: activeChainId,
              ydBalance: { status: "loading" },
            }
          : current,
      );
      refreshYdBalance(setConnection, provider, chainConfig, switchedAddress, activeChainId);
    } catch (error) {
      setErrorMessage(
        error instanceof ActionableWalletError
          ? error.message
          : walletErrorMessage(error, "switch"),
      );
    }
  }, [chainConfig, connection]);

  // F-402: listen for account/network changes initiated *inside the wallet*
  // (not through this app's own connect/switch buttons) — MetaMask's
  // accountsChanged/chainChanged events — so the app's state can't silently
  // diverge from the wallet's real state (AC-403's "界面反映新状态").
  useEffect(() => {
    const provider = typeof window === "undefined" ? undefined : window.ethereum;
    if (!provider?.on) return;

    const handleAccountsChanged = (payload: unknown) => {
      const nextAddress =
        Array.isArray(payload) && typeof payload[0] === "string"
          ? (payload[0] as HexAddress)
          : undefined;
      const current = connectionRef.current;
      // Only react if the app already had an active session — an
      // accounts-changed event while never connected in-app has nothing to
      // reconcile against.
      if (current.status !== "connected") return;
      if (!nextAddress) {
        setConnection({ status: "disconnected" });
        return;
      }
      if (nextAddress === current.address) return;
      setConnection({
        status: "connected",
        address: nextAddress,
        chainId: current.chainId,
        ydBalance:
          current.chainId === chainConfig.chainId
            ? { status: "loading" }
            : { status: "unavailable" },
      });
      if (current.chainId === chainConfig.chainId) {
        refreshYdBalance(setConnection, provider, chainConfig, nextAddress, current.chainId);
      }
    };

    const handleChainChanged = (payload: unknown) => {
      const nextChainId = typeof payload === "string" ? Number.parseInt(payload, 16) : undefined;
      const current = connectionRef.current;
      if (nextChainId === undefined || current.status !== "connected") return;
      if (nextChainId === current.chainId) return;
      const matchesTarget = nextChainId === chainConfig.chainId;
      setConnection({
        status: "connected",
        address: current.address,
        chainId: nextChainId,
        ydBalance: matchesTarget ? { status: "loading" } : { status: "unavailable" },
      });
      if (matchesTarget) {
        refreshYdBalance(setConnection, provider, chainConfig, current.address, nextChainId);
      }
    };

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [chainConfig]);

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
