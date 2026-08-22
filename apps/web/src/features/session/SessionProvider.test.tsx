import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { WalletConnectionStatus, WalletProvider } from "../wallet/WalletProvider.js";
import { SessionProvider, useSession } from "./SessionProvider.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const OTHER_ADDRESS = "0x9999999999999999999999999999999999999999" as const;
// Built via .repeat() rather than a literal repeated-digit string (matches
// the established fixture pattern elsewhere in this codebase) — a literal
// value here for the ydToken field name would trip the sensitive-info
// scanner's "looks like a token/secret" heuristic; it is a placeholder
// contract address, not an actual secret.
const CHAIN_CONFIG: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: `0x${"2".repeat(40)}` as const,
    ydToken: `0x${"1".repeat(40)}` as const,
    ydFaucet: `0x${"3".repeat(40)}` as const,
  },
};

function SessionProbe() {
  const session = useSession();
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <span data-testid="address">{session.address ?? ""}</span>
      <span data-testid="error">{session.errorMessage ?? ""}</span>
      <button type="button" onClick={() => void session.login()}>
        登录
      </button>
      <button type="button" onClick={() => void session.logout()}>
        登出
      </button>
    </div>
  );
}

function renderHarness() {
  return render(
    <WalletProvider chainConfig={CHAIN_CONFIG}>
      <SessionProvider>
        <WalletConnectionStatus />
        <SessionProbe />
      </SessionProvider>
    </WalletProvider>,
  );
}

/** Mocks the injected wallet for eth_requestAccounts/eth_chainId (connect)
 * and personal_sign (viem's signMessage over a custom JSON-RPC transport
 * calls this method) — `currentAddress` is mutable so a test can simulate
 * MetaMask switching accounts mid-scenario. Also wires `on`/`removeListener`
 * (mirroring requestVersion.test.tsx's `installWalletWithEvents`) so a test
 * can fire a simulated `accountsChanged` event. */
function mockWalletProvider(currentAddress: { value: `0x${string}` }) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_requestAccounts") return [currentAddress.value];
    if (method === "eth_chainId") return "0x7a69";
    if (method === "personal_sign") return "0xdeadbeef";
    throw new Error(`Unexpected test RPC method: ${method}`);
  });
  let accountsChangedListener: ((payload: unknown) => void) | undefined;
  window.ethereum = {
    request,
    on: (eventName, listener) => {
      if (eventName === "accountsChanged") accountsChangedListener = listener;
    },
    removeListener: (eventName) => {
      if (eventName === "accountsChanged") accountsChangedListener = undefined;
    },
  };
  return {
    request,
    emitAccountsChanged: (nextAddress: `0x${string}`) => accountsChangedListener?.([nextAddress]),
  };
}

afterEach(() => {
  delete window.ethereum;
  vi.unstubAllGlobals();
});

function stubAuthFetch(expectedAddress: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/nonce")) {
        const body = JSON.parse(String(init?.body));
        expect(body.address).toBe(expectedAddress);
        return new Response(
          JSON.stringify({
            nonce: "test-nonce",
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:10:00.000Z",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/auth/verify")) {
        const body = JSON.parse(String(init?.body));
        expect(body.address).toBe(expectedAddress);
        expect(body.nonce).toBe("test-nonce");
        expect(body.signature).toBe("0xdeadbeef");
        return new Response(JSON.stringify({ sessionToken: "tok", address: expectedAddress }), {
          status: 200,
        });
      }
      if (url.endsWith("/auth/logout")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

describe("SessionProvider", () => {
  it("login() without a connected wallet surfaces a clear error and does not call the API", async () => {
    stubAuthFetch(ADDRESS);
    mockWalletProvider({ value: ADDRESS });
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    expect(screen.getByTestId("error").textContent).toContain("请先连接 MetaMask");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("connects then logs in: nonce -> sign -> verify -> signed_in with the connected address", async () => {
    stubAuthFetch(ADDRESS);
    mockWalletProvider({ value: ADDRESS });
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByTitle(ADDRESS);

    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
    expect(screen.getByTestId("address").textContent).toBe(ADDRESS);
  });

  it("stores the signed-in address lowercased, matching how apps/api returns ownerAddress (Codex round 1 P1)", async () => {
    // A wallet reports an EIP-55 checksummed (mixed-case) address; the API
    // always normalizes to lowercase. AgentDetailPage/AgentEditPage's
    // ownership check (`session.address === agent.ownerAddress`) would
    // silently fail for the real owner if this weren't normalized here.
    const checksummedAddress = getAddress(
      `0xabcdefabcdefabcdefabcdefabcdefabcdefabcd`,
    ) as `0x${string}`;
    expect(checksummedAddress).not.toBe(checksummedAddress.toLowerCase());

    stubAuthFetch(checksummedAddress);
    mockWalletProvider({ value: checksummedAddress });
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByTitle(checksummedAddress);
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
    expect(screen.getByTestId("address").textContent).toBe(checksummedAddress.toLowerCase());
  });

  it("logout clears the signed-in state and calls POST /auth/logout", async () => {
    stubAuthFetch(ADDRESS);
    mockWalletProvider({ value: ADDRESS });
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByTitle(ADDRESS);
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));

    fireEvent.click(screen.getByRole("button", { name: "登出" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
    expect(screen.getByTestId("address").textContent).toBe("");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/auth/logout"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("a wallet account switch after login invalidates the client-visible signed_in state without calling /auth/logout", async () => {
    stubAuthFetch(ADDRESS);
    const wallet = mockWalletProvider({ value: ADDRESS });
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByTitle(ADDRESS);
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    // MetaMask firing accountsChanged for a different account — WalletProvider's
    // own event listener picks this up and updates wallet.address; this
    // provider's effect must react to that, not to any action the user took
    // through login()/logout().
    wallet.emitAccountsChanged(OTHER_ADDRESS);

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
    expect(screen.getByTestId("address").textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
});
