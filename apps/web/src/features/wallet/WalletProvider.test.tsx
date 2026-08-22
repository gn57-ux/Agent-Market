import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionStatus, WalletProvider } from "./WalletProvider.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const YD_TOKEN = "0x1111111111111111111111111111111111111111" as const;
const TARGET_CHAIN: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: "0x2222222222222222222222222222222222222222",
    ydToken: YD_TOKEN,
    ydFaucet: "0x3333333333333333333333333333333333333333",
  },
};

function uint256Result(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function installWallet(chainId: number) {
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
  window.ethereum = { request };
  return request;
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
    const request = installWallet(TARGET_CHAIN.chainId);
    renderWallet();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));

    expect(await screen.findByRole("button", { name: "0x1234…7890" })).toBeTruthy();
    expect(screen.getByText("当前网络：Local Hardhat")).toBeTruthy();
    expect(await screen.findByText("YD 余额：123.45 YD")).toBeTruthy();
    expect(request).toHaveBeenCalledWith({ method: "eth_requestAccounts" }, undefined);
    expect(
      request.mock.calls.some(
        ([rpcRequest]) =>
          rpcRequest.method === "eth_call" && JSON.stringify(rpcRequest).includes(YD_TOKEN),
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
});
