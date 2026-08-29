import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FaucetClaimButton } from "./FaucetClaimButton.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const TESTNET_CHAIN_CONFIG: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  isTestnet: true,
  addresses: {
    taskEscrow: `0x${"2".repeat(40)}` as const,
    ydToken: `0x${"1".repeat(40)}` as const,
    ydFaucet: `0x${"3".repeat(40)}` as const,
  },
};
const MAINNET_CHAIN_CONFIG: ChainConfig = { ...TESTNET_CHAIN_CONFIG, isTestnet: false };

const writeContract = vi.fn();
const waitForTransactionReceipt = vi.fn();
const readContract = vi.fn();
const refreshBalance = vi.fn();

let mockChainConfig = TESTNET_CHAIN_CONFIG;
let mockConnected = true;
let mockCorrectNetwork = true;
let mockIdentityGeneration = 1;

vi.mock("./WalletProvider.js", () => ({
  useWallet: () => ({
    connection: mockConnected
      ? { status: "connected", address: ADDRESS, chainId: mockChainConfig.chainId }
      : { status: "disconnected" },
    address: mockConnected ? ADDRESS : undefined,
    chainId: mockChainConfig.chainId,
    chainConfig: mockChainConfig,
    isCorrectNetwork: mockCorrectNetwork,
    errorMessage: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchNetwork: vi.fn(),
    identityGeneration: mockIdentityGeneration,
    getIdentityGeneration: () => mockIdentityGeneration,
    signMessage: vi.fn(),
    getWalletClient: () => ({ writeContract }),
    getPublicClient: () => ({ waitForTransactionReceipt, readContract }),
    refreshBalance,
  }),
}));

const CLAIM_AMOUNT = 100n * 10n ** 18n;
const COOLDOWN_SECONDS = 60n;

function mockFaucetReads({ lastClaimedAt = 0n }: { lastClaimedAt?: bigint } = {}) {
  readContract.mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === "claimAmount") return Promise.resolve(CLAIM_AMOUNT);
    if (functionName === "cooldownPeriod") return Promise.resolve(COOLDOWN_SECONDS);
    if (functionName === "lastClaimedAt") return Promise.resolve(lastClaimedAt);
    throw new Error(`unexpected functionName: ${functionName}`);
  });
}

beforeEach(() => {
  mockChainConfig = TESTNET_CHAIN_CONFIG;
  mockConnected = true;
  mockCorrectNetwork = true;
  mockIdentityGeneration = 1;
  writeContract.mockReset();
  waitForTransactionReceipt.mockReset();
  readContract.mockReset();
  refreshBalance.mockReset();
  mockFaucetReads();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FaucetClaimButton", () => {
  it("renders nothing on a non-testnet chain (Task B: 只用于本地 Hardhat/允许的测试网络)", () => {
    mockChainConfig = MAINNET_CHAIN_CONFIG;
    const { container } = render(<FaucetClaimButton />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when disconnected or on the wrong network", () => {
    mockConnected = false;
    const { container: disconnected } = render(<FaucetClaimButton />);
    expect(disconnected.innerHTML).toBe("");

    mockConnected = true;
    mockCorrectNetwork = false;
    const { container: wrongNetwork } = render(<FaucetClaimButton />);
    expect(wrongNetwork.innerHTML).toBe("");
  });

  it("shows the real on-chain claim amount when not on cooldown", async () => {
    render(<FaucetClaimButton />);
    const button = await screen.findByRole("button", { name: "领取测试 YD（100 YD）" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("disables the button and shows a countdown when already on cooldown", async () => {
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    mockFaucetReads({ lastClaimedAt: nowSeconds - 30n }); // 30s into a 60s cooldown
    render(<FaucetClaimButton />);
    const button = await screen.findByRole("button", { name: /后可再次领取/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("claiming calls writeContract, refreshes the wallet balance, and invokes onClaimed (Task B: 领取后余额必须自动刷新)", async () => {
    writeContract.mockResolvedValue(`0x${"a".repeat(64)}`);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    const onClaimed = vi.fn();

    render(<FaucetClaimButton onClaimed={onClaimed} />);
    const button = await screen.findByRole("button", { name: "领取测试 YD（100 YD）" });
    fireEvent.click(button);

    await waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1));
    expect(onClaimed).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claim", account: ADDRESS }),
    );
  });

  it("re-enables the button on its own once the on-chain cooldown elapses, with no page refresh (N4 review P2 regression)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    // Cooldown ends 2 (simulated) seconds from now.
    mockFaucetReads({ lastClaimedAt: nowSeconds - COOLDOWN_SECONDS + 2n });
    render(<FaucetClaimButton />);

    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: /后可再次领取/ })).toBeTruthy();
    });
    const button = screen.getByRole("button", { name: /后可再次领取/ });
    expect(button.hasAttribute("disabled")).toBe(true);

    // Advance past the cooldown boundary — the component's own 1s ticking
    // effect (not a re-render triggered by this test) must pick this up.
    await vi.advanceTimersByTimeAsync(3000);

    await vi.waitFor(() => {
      const nowEnabled = screen.getByRole("button", { name: "领取测试 YD（100 YD）" });
      expect(nowEnabled.hasAttribute("disabled")).toBe(false);
    });
  });
});
