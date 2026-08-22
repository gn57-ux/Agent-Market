import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionStatus, WalletProvider } from "./WalletProvider.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const YD_TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const TARGET_CHAIN: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: "0x2222222222222222222222222222222222222222",
    ydToken: YD_TOKEN_ADDRESS,
    ydFaucet: "0x3333333333333333333333333333333333333333",
  },
};

function uint256Result(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

type ProviderEvent = "accountsChanged" | "chainChanged";

function installWallet(chainId: number) {
  const listeners = new Map<ProviderEvent, Set<(payload: unknown) => void>>();
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === "eth_requestAccounts") return [ADDRESS];
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_call") {
      const call = Array.isArray(params) ? params[0] : undefined;
      const calldata =
        typeof call === "object" && call !== null && "data" in call && typeof call.data === "string"
          ? call.data
          : "";
      if (calldata.startsWith("0x313ce567")) return uint256Result(6n);
      if (calldata.startsWith("0x70a08231")) return uint256Result(123_450_000n);
    }
    if (method === "wallet_switchEthereumChain") return null;
    throw new Error(`Unexpected test RPC method: ${method}`);
  });
  const on = (event: ProviderEvent, listener: (payload: unknown) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
  };
  const removeListener = (event: ProviderEvent, listener: (payload: unknown) => void) => {
    listeners.get(event)?.delete(listener);
  };
  const emit = (event: ProviderEvent, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  window.ethereum = { request, on, removeListener };
  return { request, emit };
}

afterEach(() => {
  delete window.ethereum;
});

function renderWallet() {
  return render(
    <WalletProvider chainConfig={TARGET_CHAIN}>
      <WalletConnectionStatus />
    </WalletProvider>,
  );
}

describe("WalletProvider", () => {
  it("connects through the injected EIP-1193 wallet and displays address, network, and YD balance", async () => {
    const { request } = installWallet(TARGET_CHAIN.chainId);
    renderWallet();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));

    expect(await screen.findByRole("button", { name: "0x1234…7890" })).toBeTruthy();
    expect(screen.getByText("当前网络：Local Hardhat")).toBeTruthy();
    expect(await screen.findByText("YD 余额：123.45 YD")).toBeTruthy();
    expect(request).toHaveBeenCalledWith({ method: "eth_requestAccounts" }, undefined);
    expect(
      request.mock.calls.some(
        ([rpcRequest]) =>
          rpcRequest.method === "eth_call" && JSON.stringify(rpcRequest).includes(YD_TOKEN_ADDRESS),
      ),
    ).toBe(true);
  });

  it("shows an actionable Chinese message when MetaMask is not installed", async () => {
    renderWallet();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));

    expect(
      await screen.findByText("未检测到 MetaMask。请先安装并启用 MetaMask 浏览器扩展，然后重试。"),
    ).toBeTruthy();
  });

  it("disconnects the application wallet session without relying on a provider RPC", async () => {
    installWallet(TARGET_CHAIN.chainId);
    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    const connectedButton = await screen.findByRole("button", { name: "0x1234…7890" });

    fireEvent.click(connectedButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "连接钱包" })).toBeTruthy());
    expect(screen.queryByText(/当前网络：/)).toBeNull();
  });

  it("shows a readable Chinese config error instead of crashing when chain config is invalid", () => {
    // Explicitly clear the env vars WalletProvider reads (rather than relying
    // on no .env existing at the repo root, which a developer/CI environment
    // could supply) so this test's failure mode is deterministic.
    vi.stubEnv("VITE_CHAIN_ID", "");
    vi.stubEnv("VITE_TASK_ESCROW_ADDRESS", "");
    vi.stubEnv("VITE_YD_TOKEN_ADDRESS", "");
    vi.stubEnv("VITE_YD_FAUCET_ADDRESS", "");

    // No chainConfig prop supplied: falls through to resolveFrontendChainConfig
    // reading import.meta.env, which is now guaranteed empty — resolveChainConfig
    // throws inside the domain package, and that must not propagate as an
    // uncaught render exception.
    render(
      <WalletProvider>
        <WalletConnectionStatus />
      </WalletProvider>,
    );

    expect(screen.getByRole("alert").textContent).toContain("应用尚未正确配置链上参数");
    expect(screen.queryByRole("button", { name: "连接钱包" })).toBeNull();

    vi.unstubAllEnvs();
  });

  it("falls back to wallet_addEthereumChain when the wallet has not registered the target chain (4902)", async () => {
    vi.stubEnv("VITE_WALLET_RPC_URL", "http://127.0.0.1:8545");
    const wrongChainId = 1;
    let activeChainId = wrongChainId;
    const addChain = vi.fn(async () => {
      activeChainId = TARGET_CHAIN.chainId;
      return null;
    });
    const switchChain = vi.fn(async () => {
      throw { code: 4902 };
    });
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "eth_requestAccounts") return [ADDRESS];
      if (method === "eth_chainId") return `0x${activeChainId.toString(16)}`;
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
        if (calldata.startsWith("0x70a08231")) return uint256Result(100_000_000n);
      }
      if (method === "wallet_switchEthereumChain") return switchChain();
      if (method === "wallet_addEthereumChain") return addChain();
      throw new Error(`Unexpected test RPC method: ${method}`);
    });
    window.ethereum = { request };

    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByText(/当前网络不正确/);

    fireEvent.click(screen.getByRole("button", { name: "切换网络" }));

    await waitFor(() => expect(addChain).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("当前网络：Local Hardhat")).toBeTruthy();
    expect(await screen.findByText("YD 余额：100 YD")).toBeTruthy();

    vi.unstubAllEnvs();
  });

  it("does not mark the network as switched when wallet_addEthereumChain adds but does not activate the target chain", async () => {
    vi.stubEnv("VITE_WALLET_RPC_URL", "http://127.0.0.1:8545");
    const wrongChainId = 1;
    // Simulates a wallet that accepts wallet_addEthereumChain but (per
    // EIP-3085, which does not require it) leaves the previously active
    // chain selected instead of switching to the newly added one.
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") return [ADDRESS];
      if (method === "eth_chainId") return `0x${wrongChainId.toString(16)}`;
      if (method === "wallet_switchEthereumChain") throw { code: 4902 };
      if (method === "wallet_addEthereumChain") return null;
      throw new Error(`Unexpected test RPC method: ${method}`);
    });
    window.ethereum = { request };

    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByText(/当前网络不正确/);

    fireEvent.click(screen.getByRole("button", { name: "切换网络" }));

    expect(await screen.findByText(/网络已添加，但钱包仍停留在原网络/)).toBeTruthy();
    // Still shows the wrong-network warning — did not optimistically flip to connected.
    expect(screen.getByText(/当前网络不正确/)).toBeTruthy();

    vi.unstubAllEnvs();
  });

  it("reflects an account switched directly inside the wallet (accountsChanged), not just app-initiated connects", async () => {
    const OTHER_ADDRESS = "0x9999999999999999999999999999999999999999" as const;
    const { emit } = installWallet(TARGET_CHAIN.chainId);
    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x1234…7890" });
    await screen.findByText("YD 余额：123.45 YD");

    emit("accountsChanged", [OTHER_ADDRESS]);

    expect(await screen.findByRole("button", { name: "0x9999…9999" })).toBeTruthy();
    // The balance re-fetch for the new account is guarded and re-runs — still resolves
    // (the mock returns the same fixed balance regardless of address).
    expect(await screen.findByText("YD 余额：123.45 YD")).toBeTruthy();
  });

  it("disconnects the app session when the wallet reports no accounts (accountsChanged: [])", async () => {
    const { emit } = installWallet(TARGET_CHAIN.chainId);
    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x1234…7890" });

    emit("accountsChanged", []);

    await waitFor(() => expect(screen.getByRole("button", { name: "连接钱包" })).toBeTruthy());
  });

  it("reflects a network switched directly inside the wallet (chainChanged), not just app-initiated switches", async () => {
    const OTHER_CHAIN_ID = 1;
    const { emit } = installWallet(TARGET_CHAIN.chainId);
    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByText("当前网络：Local Hardhat");

    emit("chainChanged", `0x${OTHER_CHAIN_ID.toString(16)}`);

    expect(await screen.findByText(/当前网络不正确/)).toBeTruthy();
  });

  it("ignores a malformed chainChanged payload instead of applying garbage as chainId", async () => {
    // Regression for Codex review round 3 P2: Number.parseInt("0x", 16) is
    // NaN and Number.parseInt("0xZZ", 16) silently parses just the "0x"
    // prefix as 0 — either would previously have been accepted as a real
    // chainId change. The wallet's `chainChanged` payload is untrusted
    // input from the injected provider and must be validated as a
    // complete, well-formed hex quantity before being applied.
    const { emit } = installWallet(TARGET_CHAIN.chainId);
    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByText("当前网络：Local Hardhat");

    emit("chainChanged", "0x");
    emit("chainChanged", "0xZZ");
    emit("chainChanged", "garbage");

    // Still on the original, correct network — none of the malformed
    // payloads were accepted as a real chain change.
    expect(screen.getByText("当前网络：Local Hardhat")).toBeTruthy();
    expect(screen.queryByText(/当前网络不正确/)).toBeNull();
  });

  it("composes an accountsChanged and a chainChanged event fired back-to-back in the same tick without dropping either update", async () => {
    // Regression for Codex review round 1 P1: reading a ref synced by a
    // separate effect could let the second handler in a same-tick batch
    // overwrite the first handler's update with a stale snapshot. Both
    // handlers must land when React composes the two functional updates.
    const OTHER_ADDRESS = "0x9999999999999999999999999999999999999999" as const;
    const OTHER_CHAIN_ID = 1;
    const { emit } = installWallet(TARGET_CHAIN.chainId);
    renderWallet();
    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByRole("button", { name: "0x1234…7890" });

    // No `await` between these two: dispatched synchronously in one tick,
    // exactly as a wallet emitting both events for one user action would.
    emit("accountsChanged", [OTHER_ADDRESS]);
    emit("chainChanged", `0x${OTHER_CHAIN_ID.toString(16)}`);

    // Both updates must be reflected — the new address is NOT lost.
    expect(await screen.findByRole("button", { name: "0x9999…9999" })).toBeTruthy();
    expect(await screen.findByText(/当前网络不正确/)).toBeTruthy();
  });
});
