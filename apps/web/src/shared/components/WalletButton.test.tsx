import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletButton } from "./WalletButton.js";

describe("WalletButton", () => {
  it("shows 连接钱包 and calls onConnect when not connected", () => {
    const onConnect = vi.fn();
    render(<WalletButton address={undefined} onConnect={onConnect} onDisconnect={vi.fn()} />);
    const button = screen.getByText("连接钱包");
    fireEvent.click(button);
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("shows a shortened address and calls onDisconnect when connected", () => {
    const onDisconnect = vi.fn();
    const address = "0x1234567890123456789012345678901234567890" as const;
    render(<WalletButton address={address} onConnect={vi.fn()} onDisconnect={onDisconnect} />);
    const button = screen.getByText("0x1234…7890");
    fireEvent.click(button);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});
