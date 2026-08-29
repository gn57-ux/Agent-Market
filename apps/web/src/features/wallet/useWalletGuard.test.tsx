import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionStatus, WalletProvider } from "./WalletProvider.js";
import { useWalletGuard } from "./useWalletGuard.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const YD_TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const TARGET_CHAIN: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  isTestnet: true,
  addresses: {
    taskEscrow: "0x2222222222222222222222222222222222222222",
    ydToken: YD_TOKEN_ADDRESS,
    ydFaucet: "0x3333333333333333333333333333333333333333",
  },
};

afterEach(() => {
  delete window.ethereum;
});

describe("useWalletGuard", () => {
  it("blocks a transaction action and exposes a switch prompt on the wrong network", async () => {
    const transactionAction = vi.fn();
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") return [ADDRESS];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "wallet_switchEthereumChain") return null;
      throw new Error(`Unexpected test RPC method: ${method}`);
    });
    window.ethereum = { request };

    function GuardedAction() {
      const guard = useWalletGuard();
      return (
        <button type="button" onClick={() => guard.runGuarded(transactionAction)}>
          提交交易
        </button>
      );
    }

    render(
      <WalletProvider chainConfig={TARGET_CHAIN}>
        <WalletConnectionStatus />
        <GuardedAction />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));

    expect(
      await screen.findByText("当前网络不正确。请切换到 Local Hardhat 后再提交交易。"),
    ).toBeTruthy();
    expect(request.mock.calls.every(([rpcRequest]) => rpcRequest.method !== "eth_call")).toBe(true);
    const switchButton = screen.getByRole("button", { name: "切换网络" });
    fireEvent.click(screen.getByRole("button", { name: "提交交易" }));
    expect(transactionAction).not.toHaveBeenCalled();

    fireEvent.click(switchButton);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x7a69" }],
      }),
    );
  });
});
