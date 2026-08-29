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
  isTestnet: true,
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
      <button type="button" onClick={() => session.logout().catch(() => undefined)}>
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
function mockWalletProvider(
  currentAddress: { value: `0x${string}` },
  options: { deferEthAccounts?: boolean; preAuthorized?: boolean } = {},
) {
  // Real production behavior: `eth_accounts` (WalletProvider's silent
  // mount-time auto-reconnect check) never resolves instantly — it's an
  // IPC round trip to the wallet extension. `deferEthAccounts` lets a test
  // hold that check open indefinitely (via `resolveEthAccounts` below) to
  // exercise the exact race window between it and SessionProvider's own
  // `GET /auth/session` restore, instead of the check settling within the
  // same microtask queue flush a plain unresolved mock would produce.
  // `preAuthorized` simulates the site already being MetaMask-authorized
  // (eth_accounts resolves to `currentAddress.value` immediately) — the
  // default, matching a first-ever visit, is no prior authorization ([]).
  let resolveEthAccounts: ((accounts: string[]) => void) | undefined;
  const deferredEthAccounts = options.deferEthAccounts
    ? new Promise<string[]>((resolve) => {
        resolveEthAccounts = resolve;
      })
    : undefined;

  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_requestAccounts") return [currentAddress.value];
    if (method === "eth_accounts") {
      if (deferredEthAccounts) return deferredEthAccounts;
      return options.preAuthorized ? [currentAddress.value] : [];
    }
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
    // MetaMask's real payload for a lock/disconnect/revoked-permission event
    // is an empty array, not a single falsy address.
    emitDisconnect: () => accountsChangedListener?.([]),
    resolveEthAccounts: (accounts: `0x${string}`[]) => resolveEthAccounts?.(accounts),
  };
}

afterEach(() => {
  delete window.ethereum;
  vi.unstubAllGlobals();
});

function stubAuthFetch(
  expectedAddress: string,
  options: { logoutFails?: boolean; restoredAddress?: string } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/session")) {
        return options.restoredAddress
          ? new Response(JSON.stringify({ address: options.restoredAddress }), { status: 200 })
          : new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), { status: 401 });
      }
      if (url.endsWith("/auth/logout") && options.logoutFails) {
        return new Response(JSON.stringify({ error: { message: "服务器错误" } }), {
          status: 500,
        });
      }
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
  it("restores signed_in on mount from a still-valid session cookie via GET /auth/session (Task E review)", async () => {
    stubAuthFetch(ADDRESS, { restoredAddress: ADDRESS });
    // No mockWalletProvider() call: simulates the real page-refresh
    // sequence, where the wallet has not (yet, or ever) auto-reconnected.
    renderHarness();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
    expect(screen.getByTestId("address").textContent).toBe(ADDRESS);
  });

  it("stays signed_out on mount when there is no valid session cookie (ordinary 401, not an error)", async () => {
    stubAuthFetch(ADDRESS);
    renderHarness();

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/session"),
        expect.anything(),
      ),
    );
    expect(screen.getByTestId("status").textContent).toBe("signed_out");
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("does not undo a restored session while the wallet's own silent auto-reconnect is still pending (regression: mount-time race)", async () => {
    stubAuthFetch(ADDRESS, { restoredAddress: ADDRESS });
    // eth_accounts deliberately never resolves during this test's assertion
    // window: wallet.address stays undefined throughout, and since this
    // tab's wallet has never actually reported a connected address yet,
    // the reconciling effect's `hasWalletEverConnectedRef` guard correctly
    // treats that as "no information yet", not a disconnect.
    mockWalletProvider({ value: ADDRESS }, { deferEthAccounts: true });
    renderHarness();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
    // Give any spurious reconciling-effect re-run a chance to fire before
    // asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("status").textContent).toBe("signed_in");
    expect(screen.getByTestId("address").textContent).toBe(ADDRESS);
  });

  it("stays signed_in when this tab's wallet never connects at all — a still-valid cookie is not a contradiction to resolve", async () => {
    stubAuthFetch(ADDRESS, { restoredAddress: ADDRESS });
    const wallet = mockWalletProvider({ value: ADDRESS }, { deferEthAccounts: true });
    renderHarness();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));

    // The wallet's own check now settles and finds NO authorized account
    // (e.g. no MetaMask permission granted in this browser/profile at all)
    // — this tab's wallet was never connected, so this is not a
    // "disconnect" to react to; the restored session is still legitimate.
    wallet.resolveEthAccounts([]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("status").textContent).toBe("signed_in");
    expect(screen.getByTestId("address").textContent).toBe(ADDRESS);
  });

  it("signs out when a wallet that WAS connected to the restored session's address genuinely disconnects (N4 review P2: real disconnect must still clear a restored session)", async () => {
    stubAuthFetch(ADDRESS, { restoredAddress: ADDRESS });
    // eth_accounts resolves immediately, matching the restored session's
    // address — this tab's wallet has now genuinely connected, so a
    // SUBSEQUENT disconnect must invalidate the client-visible session.
    const wallet = mockWalletProvider({ value: ADDRESS }, { preAuthorized: true });
    renderHarness();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
    // Wait for the wallet's own auto-reconnect to actually settle too —
    // this test is specifically about a wallet that WAS connected, so it
    // must genuinely reach that state before disconnecting from it.
    await waitFor(() => expect(screen.getByRole("button", { name: "0x1234…7890" })).toBeTruthy());

    wallet.emitDisconnect();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
    expect(screen.getByTestId("address").textContent).toBe("");
  });

  it("does not resurrect a session the user just logged out of, if the mount-time restore resolves late (N4 review P2: stale-restore-vs-logout race)", async () => {
    let resolveWhoami: ((response: Response) => void) | undefined;
    mockWalletProvider({ value: ADDRESS });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/session")) {
          return new Promise<Response>((resolve) => {
            resolveWhoami = resolve;
          });
        }
        if (url.endsWith("/auth/logout")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    renderHarness();

    // The user logs out before the mount-time restore has resolved at all
    // (it's still pending — resolveWhoami hasn't been called yet).
    fireEvent.click(screen.getByRole("button", { name: "登出" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));

    // The restore now finally resolves, with a stale "you're signed in"
    // answer from before the logout — this must NOT override what logout()
    // already decided.
    resolveWhoami?.(new Response(JSON.stringify({ address: ADDRESS }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("status").textContent).toBe("signed_out");
    expect(screen.getByTestId("address").textContent).toBe("");
  });

  it("login() without a connected wallet surfaces a clear error and does not call the API", async () => {
    stubAuthFetch(ADDRESS);
    mockWalletProvider({ value: ADDRESS });
    renderHarness();
    // Let the mount-time GET /auth/session restore check settle (an
    // unrelated, expected call — this test is about login() itself) before
    // asserting on calls login() triggers.
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/session"),
        expect.anything(),
      ),
    );
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

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

  it("keeps status signed_in and surfaces the error when /auth/logout itself fails (Codex round 2 P2)", async () => {
    // The session cookie is still valid server-side if revocation failed —
    // clearing local state anyway would falsely tell the user they're
    // logged out while the session can still authenticate requests.
    stubAuthFetch(ADDRESS, { logoutFails: true });
    mockWalletProvider({ value: ADDRESS });
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
    await screen.findByTitle(ADDRESS);
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));

    fireEvent.click(screen.getByRole("button", { name: "登出" }));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("服务器错误"));
    expect(screen.getByTestId("status").textContent).toBe("signed_in");
    expect(screen.getByTestId("address").textContent).toBe(ADDRESS);
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
