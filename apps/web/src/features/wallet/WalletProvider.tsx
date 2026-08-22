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
  /**
   * Monotonically increasing "wallet identity generation" as of the last
   * render — a snapshot value, suitable for display or as a React
   * dependency, but NOT for a point-in-time staleness check (see
   * `getIdentityGeneration` for that). Bumped synchronously by
   * `WalletProvider` itself, at the exact moment address/chainId actually
   * changes, from plain function bodies only (event handlers, connect/
   * disconnect/switchNetwork) — never from inside a `setConnection` updater
   * callback. React may invoke a state updater function more than once for
   * a single logical update (StrictMode's dev-mode double-invoke exists
   * specifically to catch impure updaters); a ref bump inside one would
   * double-count. Tracking it here, at the source, also closes an ABA/
   * batching gap a downstream consumer can't: if MetaMask fires two events
   * (e.g. accountsChanged then chainChanged) synchronously in the same
   * tick, React 18 batches both `setConnection` calls into a single render
   * — a consumer deriving "did identity change" from its own render would
   * only ever see the final state and could miss an intervening identity
   * entirely. Bumping here, once per real transition, regardless of
   * whether React ever schedules a render for it, has no such gap.
   */
  identityGeneration: number;
  /**
   * Live read of the same counter `identityGeneration` snapshots at render
   * time — call this instead of using a value mirrored from
   * `identityGeneration` inside a ref, for any check that must not wait for
   * a React render. Codex review (P1): `useVersionedAsync`'s staleness
   * check previously mirrored `identityGeneration` into its own `useRef`
   * during render; if the identity changed and the async operation settled
   * in the window before that consumer's next render committed, the
   * mirrored ref still held the stale value and the check incorrectly
   * passed. `getIdentityGeneration()` reads the provider's own ref
   * directly — always current, independent of whether or when this
   * consumer re-renders. A stable function identity across renders (never
   * needs to appear in a dependency array to stay fresh).
   */
  getIdentityGeneration: () => number;
  /**
   * Requests a plain-text signature from the connected wallet (EIP-191
   * personal_sign, via viem's `signMessage`) — the one place wallet-client
   * construction for signing lives, so Feature 5's session/login module
   * doesn't need to know how to talk to `window.ethereum` itself. Throws
   * if no wallet is connected. Used for the backend's SIWE-style sign-in
   * message (`/auth/nonce` → sign → `/auth/verify`, Feature 4's
   * `signInMessage.ts`) — this function only performs the signature, it
   * has no knowledge of that protocol.
   */
  signMessage: (message: string) => Promise<string>;
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

/** MetaMask's `chainChanged` payload is an untrusted string from the
 * injected provider. Codex review (P2): `Number.parseInt(payload, 16)`
 * silently accepts malformed input like `"0x"` (NaN) or `"0xZZ"` (parses
 * the valid hex prefix and ignores the rest), which would then get applied
 * as a real `chainId` and advance the identity generation on garbage.
 * Requires a complete, non-empty `0x`-prefixed hex quantity, and that the
 * parsed value is a finite safe integer (chain IDs fit comfortably within
 * that range; anything else indicates a malformed or hostile payload). */
function parseHexChainId(payload: unknown): number | undefined {
  if (typeof payload !== "string" || !/^0x[0-9a-fA-F]+$/.test(payload)) {
    return undefined;
  }
  const parsed = Number.parseInt(payload, 16);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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

  // Source of truth for `identityGeneration` (see WalletContextValue's doc
  // comment). `latestAddressRef`/`latestChainIdRef` mirror "what identity
  // are we at right now" so each transition site can detect a real change,
  // and other sites (e.g. switchNetwork's post-await race guard, below) can
  // check "did the identity move on without me" — without depending on
  // React's `connection` state, which may not reflect an intermediate
  // transition that got batched away before ever rendering, and without
  // depending on exactly when React invokes a `setConnection` updater
  // function relative to the surrounding code (unspecified by React; not
  // safe to rely on for synchronous side effects).
  const latestAddressRef = useRef<HexAddress | undefined>(undefined);
  const latestChainIdRef = useRef<number | undefined>(undefined);
  const identityGenerationRef = useRef(0);

  /** Bumps `identityGenerationRef` iff `nextAddress`/`nextChainId` differ
   * from the last-recorded identity. Call ONLY from plain function bodies
   * (event handlers, connect/disconnect/switchNetwork) — never from inside
   * a `setConnection` updater callback. React may invoke a state updater
   * function more than once for a single logical update (StrictMode's
   * dev-mode double-invoke exists specifically to catch impure updaters);
   * a ref bump inside one would double-count. */
  function recordIdentityIfChanged(
    nextAddress: HexAddress | undefined,
    nextChainId: number | undefined,
  ): void {
    if (nextAddress === latestAddressRef.current && nextChainId === latestChainIdRef.current) {
      return;
    }
    latestAddressRef.current = nextAddress;
    latestChainIdRef.current = nextChainId;
    identityGenerationRef.current += 1;
  }

  // Stable across renders (empty deps; reads the ref directly at call time)
  // — see WalletContextValue.getIdentityGeneration's doc comment for why a
  // point-in-time staleness check needs this instead of a render-snapshotted
  // value.
  const getIdentityGeneration = useCallback(() => identityGenerationRef.current, []);

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
      recordIdentityIfChanged(address, chainId);
      setConnection({
        status: "connected",
        address,
        chainId,
        ydBalance: needsNetworkSwitch ? { status: "unavailable" } : { status: "loading" },
      });
      // Balance fetch itself is triggered by the dedicated effect below,
      // which watches for `ydBalance.status === "loading"` — a single
      // trigger point shared by connect/switchNetwork/wallet-events instead
      // of each call site separately kicking off the read.
    } catch (error) {
      recordIdentityIfChanged(undefined, undefined);
      setConnection({ status: "disconnected" });
      setErrorMessage(
        error instanceof ActionableWalletError
          ? error.message
          : walletErrorMessage(error, "connect"),
      );
    }
  }, [chainConfig]);

  const disconnect = useCallback(() => {
    recordIdentityIfChanged(undefined, undefined);
    setConnection({ status: "disconnected" });
    setErrorMessage(undefined);
  }, []);

  const switchNetwork = useCallback(async () => {
    if (connection.status !== "connected") {
      setErrorMessage("请先连接 MetaMask，再切换网络。");
      return;
    }
    const switchTargetAddress = connection.address;
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
      // Guarded, not an unconditional overwrite: if the user disconnected
      // (or switched account) while this switch/add-chain round trip was in
      // flight, this must not resurrect a stale "connected" state. Uses the
      // functional updater (reads React's true latest `current`, not a
      // value closed over when switchNetwork was called) so this composes
      // correctly even if a wallet-emitted event updated `connection` in
      // between.
      setConnection((current) =>
        current.status === "connected"
          ? {
              status: "connected",
              address: current.address,
              chainId: activeChainId,
              ydBalance: { status: "loading" },
            }
          : current,
      );
      // Same race guard as the setConnection call above, expressed against
      // `latestAddressRef` instead of the updater's `current` (see
      // `recordIdentityIfChanged`'s doc comment for why this can't safely
      // read the updater's own decision): only record the new chainId
      // against `switchTargetAddress` if the wallet's connected address is
      // still the one this switchNetwork call started for.
      if (latestAddressRef.current === switchTargetAddress) {
        recordIdentityIfChanged(switchTargetAddress, activeChainId);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof ActionableWalletError
          ? error.message
          : walletErrorMessage(error, "switch"),
      );
    }
  }, [chainConfig, connection]);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      if (connection.status !== "connected") {
        throw new ActionableWalletError("请先连接 MetaMask 钱包，再签名登录。");
      }
      const provider = requireInjectedProvider();
      const walletClient = createWalletClient({ transport: custom(provider) });
      return walletClient.signMessage({ account: connection.address, message });
    },
    [connection],
  );

  // F-402: listen for account/network changes initiated *inside the wallet*
  // (not through this app's own connect/switch buttons) — MetaMask's
  // accountsChanged/chainChanged events — so the app's state can't silently
  // diverge from the wallet's real state (AC-403's "界面反映新状态").
  //
  // Both handlers still apply their actual `connection` state change via
  // the functional `setConnection(current => ...)` form (Codex review round
  // 1: a ref synced via a separate `useEffect` could drop an account update
  // when both events fire together, since the effect hadn't run yet when
  // the second handler read it — reading React's own always-fresh `current`
  // instead has no such gap for *state composition*).
  //
  // But "did identity actually change, and by how much" (`identityGeneration`)
  // is decided BEFORE calling setConnection, from `latestAddressRef`/
  // `latestChainIdRef` — not from `current` inside the updater. Codex review
  // round 2: deriving the generation from a downstream consumer's *render*
  // of `connection` misses transitions that get batched away (React 18
  // coalesces two same-tick setConnection calls into one render, so a
  // consumer could observe only the final identity and never the
  // intermediate one — an ABA case, or a single change that settles before
  // the next render). Recording it here, synchronously in the handler body,
  // once per real event regardless of whether a render happens for it,
  // closes that gap.
  useEffect(() => {
    const provider = typeof window === "undefined" ? undefined : window.ethereum;
    if (!provider?.on) return;

    const handleAccountsChanged = (payload: unknown) => {
      // Only react if the app already had an active session — an
      // accounts-changed event while never connected in-app has nothing to
      // reconcile against. Gated on the ref (not `connection.status`) so
      // this decision is correct even if a just-prior same-tick event (e.g.
      // handleChainChanged, if the wallet fires both back to back) already
      // advanced identity past what the last render observed.
      if (latestAddressRef.current === undefined) return;

      const nextAddress =
        Array.isArray(payload) && typeof payload[0] === "string"
          ? (payload[0] as HexAddress)
          : undefined;
      if (nextAddress === latestAddressRef.current) return;

      // Codex review round 2 (P2): a wallet-driven change succeeding must
      // clear any stale error left over from a previous *failed* in-app
      // action (e.g. a cancelled switchNetwork) — otherwise the old failure
      // message stays visible next to state that now looks fine.
      setErrorMessage(undefined);

      if (!nextAddress) {
        recordIdentityIfChanged(undefined, undefined);
        setConnection({ status: "disconnected" });
        return;
      }
      const currentChainId = latestChainIdRef.current;
      recordIdentityIfChanged(nextAddress, currentChainId);
      setConnection((current) =>
        current.status === "connected"
          ? {
              status: "connected",
              address: nextAddress,
              chainId: current.chainId,
              ydBalance:
                current.chainId === chainConfig.chainId
                  ? { status: "loading" }
                  : { status: "unavailable" },
            }
          : current,
      );
    };

    const handleChainChanged = (payload: unknown) => {
      if (latestAddressRef.current === undefined) return;

      const nextChainId = parseHexChainId(payload);
      if (nextChainId === undefined || nextChainId === latestChainIdRef.current) return;

      // Same rationale as handleAccountsChanged: a wallet-driven change
      // succeeding clears a stale error from a previous failed in-app
      // action.
      setErrorMessage(undefined);

      recordIdentityIfChanged(latestAddressRef.current, nextChainId);
      setConnection((current) =>
        current.status === "connected"
          ? {
              status: "connected",
              address: current.address,
              chainId: nextChainId,
              ydBalance:
                nextChainId === chainConfig.chainId
                  ? { status: "loading" }
                  : { status: "unavailable" },
            }
          : current,
      );
    };

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [chainConfig]);

  // Single trigger point for the YD balance read: fires whenever `connection`
  // moves into a "loading" balance state, regardless of which of
  // connect/switchNetwork/the wallet-event handlers above put it there. Keeps
  // "when do we (re-)fetch the balance" single-sourced instead of duplicated
  // at every call site that can transition into "connected".
  useEffect(() => {
    if (connection.status !== "connected" || connection.ydBalance.status !== "loading") return;
    const provider = typeof window === "undefined" ? undefined : window.ethereum;
    if (!provider) return;
    refreshYdBalance(setConnection, provider, chainConfig, connection.address, connection.chainId);
  }, [connection, chainConfig]);

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
      identityGeneration: identityGenerationRef.current,
      getIdentityGeneration,
      signMessage,
    }),
    [
      address,
      chainConfig,
      chainId,
      connect,
      connection,
      disconnect,
      errorMessage,
      switchNetwork,
      getIdentityGeneration,
      signMessage,
      // `connection` above already changes on every real identity
      // transition (each one has a corresponding `recordIdentityIfChanged`
      // call), so this recomputes whenever the generation could have
      // bumped; listed explicitly so the dependency itself isn't silently
      // relying on that correlation holding forever.
      identityGenerationRef.current,
    ],
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
    <section aria-label="钱包状态" className="flex flex-wrap items-center gap-3 text-caption">
      <WalletButton
        address={wallet.address}
        onConnect={() => void wallet.connect()}
        onDisconnect={wallet.disconnect}
      />
      {wallet.connection.status === "connecting" && (
        <span className="text-ink-secondary">正在连接钱包…</span>
      )}
      {connected && (
        <span className="text-ink-secondary">
          当前网络：{currentNetworkName(connected.chainId)}
        </span>
      )}
      {connected?.ydBalance.status === "ready" && (
        <span className="text-ink-secondary">YD 余额：{connected.ydBalance.formatted} YD</span>
      )}
      {connected?.ydBalance.status === "loading" && wallet.isCorrectNetwork && (
        <span className="text-ink-secondary">正在读取 YD 余额…</span>
      )}
      {connected?.ydBalance.status === "error" && (
        <span role="alert" className="text-warning">
          {connected.ydBalance.message}
        </span>
      )}
      {connected && !wallet.isCorrectNetwork && (
        <div role="alert" className="flex items-center gap-2 text-warning">
          当前网络不正确。请切换到 {wallet.chainConfig.name} 后再提交交易。
          <button
            type="button"
            onClick={() => void wallet.switchNetwork()}
            className="rounded-control border border-warning px-2.5 py-1 text-caption text-warning hover:bg-warning/10"
          >
            切换网络
          </button>
        </div>
      )}
      {wallet.errorMessage && (
        <div role="alert" className="text-warning">
          {wallet.errorMessage}
        </div>
      )}
    </section>
  );
}
