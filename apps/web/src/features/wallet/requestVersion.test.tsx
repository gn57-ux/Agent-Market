import type { ChainConfig } from "@agent-market/domain";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionStatus, WalletProvider } from "./WalletProvider.js";
import { useRequestVersion, useVersionedAsync } from "./requestVersion.js";

const ADDRESS_A = "0x1234567890123456789012345678901234567890" as const;
const ADDRESS_B = "0x9876543210987654321098765432109876543210" as const;
const YD_TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const TASK_ESCROW_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const YD_FAUCET_ADDRESS = "0x3333333333333333333333333333333333333333" as const;

const TARGET_CHAIN: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: TASK_ESCROW_ADDRESS,
    ydToken: YD_TOKEN_ADDRESS,
    ydFaucet: YD_FAUCET_ADDRESS,
  },
};
const WRONG_CHAIN_ID = 1;

function uint256Result(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function installWallet(address: `0x${string}`, chainId: number) {
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === "eth_requestAccounts") return [address];
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "eth_call") {
      const call = Array.isArray(params) ? params[0] : undefined;
      const calldata =
        typeof call === "object" && call !== null && "data" in call && typeof call.data === "string"
          ? call.data
          : "";
      if (calldata.startsWith("0x313ce567")) return uint256Result(6n);
      if (calldata.startsWith("0x70a08231")) return uint256Result(1_000_000n);
    }
    throw new Error(`Unexpected test RPC method: ${method}`);
  });
  window.ethereum = { request };
}

interface EventCapableWallet {
  emitAccountsChanged(address: `0x${string}`): void;
  emitChainChanged(chainId: number): void;
}

/** Same as `installWallet`, but also wires MetaMask's `on`/`removeListener`
 * so a test can directly invoke the captured listeners — synchronously,
 * back-to-back, with no `await`/render between them — to reproduce a real
 * same-tick wallet event burst (e.g. accountsChanged immediately followed
 * by chainChanged), which is exactly what React 18 batches into a single
 * render and what the earlier ABA regression test above (which awaits a
 * render between each step) cannot reproduce. */
function installWalletWithEvents(address: `0x${string}`, chainId: number): EventCapableWallet {
  installWallet(address, chainId);
  let accountsChangedListener: ((payload: unknown) => void) | undefined;
  let chainChangedListener: ((payload: unknown) => void) | undefined;
  const existing = window.ethereum;
  if (!existing) throw new Error("installWallet did not set window.ethereum");
  existing.on = (eventName, listener) => {
    if (eventName === "accountsChanged") accountsChangedListener = listener;
    if (eventName === "chainChanged") chainChangedListener = listener;
  };
  existing.removeListener = (eventName) => {
    if (eventName === "accountsChanged") accountsChangedListener = undefined;
    if (eventName === "chainChanged") chainChangedListener = undefined;
  };
  return {
    emitAccountsChanged: (nextAddress) => accountsChangedListener?.([nextAddress]),
    emitChainChanged: (nextChainId) => chainChangedListener?.(`0x${nextChainId.toString(16)}`),
  };
}

afterEach(() => {
  delete window.ethereum;
});

/** Exposes the current request version as text so tests can assert on it. */
function VersionProbe() {
  const version = useRequestVersion();
  return <span data-testid="version">{version}</span>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Starts a versioned async op backed by an externally-controlled deferred
 * promise, and reports whether the result was kept (defined) or discarded
 * as stale (undefined) once `run` settles. */
function VersionedAsyncProbe({
  deferred,
  onSettled,
}: {
  deferred: Deferred<string>;
  onSettled: (result: string | undefined) => void;
}) {
  const { run } = useVersionedAsync<string>();
  return (
    <button
      type="button"
      onClick={() => {
        void run((isStale) => {
          expect(isStale()).toBe(false); // not stale at the moment fn starts
          return deferred.promise;
        }).then(onSettled);
      }}
    >
      start-async
    </button>
  );
}

describe("useRequestVersion", () => {
  it("changes identity when the connected address changes", async () => {
    installWallet(ADDRESS_A, TARGET_CHAIN.chainId);
    render(
      <WalletProvider chainConfig={TARGET_CHAIN}>
        <WalletConnectionStatus />
        <VersionProbe />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    const connectedAsA = await screen.findByRole("button", { name: "0x1234…7890" });
    const versionAfterA = screen.getByTestId("version").textContent;

    // Disconnect, then reconnect as a different address (simulates the user
    // switching MetaMask accounts and the app re-establishing connection).
    fireEvent.click(connectedAsA);
    await waitFor(() => expect(screen.getByTestId("version").textContent).not.toBe(versionAfterA));

    installWallet(ADDRESS_B, TARGET_CHAIN.chainId);
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x9876…3210" });

    const versionAfterB = screen.getByTestId("version").textContent;
    expect(versionAfterB).not.toBe(versionAfterA);
  });

  it("changes identity when the active chainId changes", async () => {
    let activeChainId: number = WRONG_CHAIN_ID;
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "eth_requestAccounts") return [ADDRESS_A];
      if (method === "eth_chainId") return `0x${activeChainId.toString(16)}`;
      if (method === "wallet_switchEthereumChain") {
        activeChainId = TARGET_CHAIN.chainId;
        return null;
      }
      if (method === "eth_call") {
        const call = Array.isArray(params) ? params[0] : undefined;
        const calldata =
          typeof call === "object" &&
          call !== null &&
          "data" in call &&
          typeof call.data === "string"
            ? call.data
            : "";
        if (calldata.startsWith("0x313ce567")) return uint256Result(6n);
        if (calldata.startsWith("0x70a08231")) return uint256Result(1_000_000n);
      }
      throw new Error(`Unexpected test RPC method: ${method}`);
    });
    window.ethereum = { request };
    render(
      <WalletProvider chainConfig={TARGET_CHAIN}>
        <WalletConnectionStatus />
        <VersionProbe />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByText(/当前网络不正确/);
    const versionOnWrongChain = screen.getByTestId("version").textContent;

    fireEvent.click(screen.getByRole("button", { name: "切换网络" }));
    await waitFor(() =>
      expect(screen.getByTestId("version").textContent).not.toBe(versionOnWrongChain),
    );
  });
});

describe("useVersionedAsync", () => {
  it("discards a result that resolves after the account changed while it was in flight", async () => {
    installWallet(ADDRESS_A, TARGET_CHAIN.chainId);
    const deferred = createDeferred<string>();
    const onSettled = vi.fn();

    render(
      <WalletProvider chainConfig={TARGET_CHAIN}>
        <WalletConnectionStatus />
        <VersionedAsyncProbe deferred={deferred} onSettled={onSettled} />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    const connectedAsA = await screen.findByRole("button", { name: "0x1234…7890" });

    fireEvent.click(screen.getByRole("button", { name: "start-async" }));

    // Switch accounts while the async op is still pending.
    fireEvent.click(connectedAsA);
    installWallet(ADDRESS_B, TARGET_CHAIN.chainId);
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x9876…3210" });

    deferred.resolve("result-for-address-a");

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled).toHaveBeenCalledWith(undefined);
  });

  it("discards a stale result even if the wallet round-trips back to the original address (ABA)", async () => {
    // Regression for Codex review round 1 P2: a version derived only from
    // (address, chainId) would treat A -> B -> A as "unchanged" by the time
    // the request settles, incorrectly accepting a result that was issued
    // against a since-superseded identity. The generation counter must
    // treat this as stale even though the identity value coincides again.
    installWallet(ADDRESS_A, TARGET_CHAIN.chainId);
    const deferred = createDeferred<string>();
    const onSettled = vi.fn();

    render(
      <WalletProvider chainConfig={TARGET_CHAIN}>
        <WalletConnectionStatus />
        <VersionedAsyncProbe deferred={deferred} onSettled={onSettled} />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    const connectedAsA = await screen.findByRole("button", { name: "0x1234…7890" });

    fireEvent.click(screen.getByRole("button", { name: "start-async" }));

    // Round-trip A -> B -> A, all before the async op settles.
    fireEvent.click(connectedAsA);
    installWallet(ADDRESS_B, TARGET_CHAIN.chainId);
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    const connectedAsB = await screen.findByRole("button", { name: "0x9876…3210" });

    fireEvent.click(connectedAsB);
    installWallet(ADDRESS_A, TARGET_CHAIN.chainId);
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x1234…7890" });

    deferred.resolve("result-for-address-a");

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled).toHaveBeenCalledWith(undefined);
  });

  it("discards a stale result even when the wallet round-trips within a single same-tick batch (real ABA, no intermediate render)", async () => {
    // Regression for Codex review round 2 P1: the earlier ABA test above
    // awaits a render for B before switching back to A, so it never
    // exercises the actual bug — two wallet-driven events (e.g. two
    // accountsChanged emissions) that fire synchronously back-to-back,
    // which React 18 batches into a SINGLE render. A version derived from
    // a downstream consumer's own render (the old implementation) would
    // observe only the final state (A) and never advance at all, since the
    // B render never happens. The fix moves generation tracking into
    // WalletProvider itself, bumped synchronously in the event-handler
    // bodies — independent of whether React ever renders the intermediate
    // identity — so this must still correctly mark the in-flight request
    // stale even though no B render occurs.
    const wallet = installWalletWithEvents(ADDRESS_A, TARGET_CHAIN.chainId);
    const deferred = createDeferred<string>();
    const onSettled = vi.fn();

    render(
      <WalletProvider chainConfig={TARGET_CHAIN}>
        <WalletConnectionStatus />
        <VersionedAsyncProbe deferred={deferred} onSettled={onSettled} />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x1234…7890" });

    fireEvent.click(screen.getByRole("button", { name: "start-async" }));

    // Fire accountsChanged(B) then accountsChanged(A) synchronously inside
    // one `act()`, with no `await`/render between them — this is what a
    // real same-tick wallet event burst looks like, and it is exactly what
    // the button-click-driven test above (which awaits a render after each
    // step) cannot reproduce.
    act(() => {
      wallet.emitAccountsChanged(ADDRESS_B);
      wallet.emitAccountsChanged(ADDRESS_A);
    });

    deferred.resolve("result-for-address-a");

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled).toHaveBeenCalledWith(undefined);
  });

  it("keeps a result that resolves while the identity is still current", async () => {
    installWallet(ADDRESS_A, TARGET_CHAIN.chainId);
    const deferred = createDeferred<string>();
    const onSettled = vi.fn();

    render(
      <WalletProvider chainConfig={TARGET_CHAIN}>
        <WalletConnectionStatus />
        <VersionedAsyncProbe deferred={deferred} onSettled={onSettled} />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x1234…7890" });

    fireEvent.click(screen.getByRole("button", { name: "start-async" }));
    deferred.resolve("result-for-address-a");

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled).toHaveBeenCalledWith("result-for-address-a");
  });
});
