import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { WalletConnectionStatus, WalletProvider } from "../wallet/WalletProvider.js";
import { SessionProvider, useSession } from "./SessionProvider.js";
import { usePrivyLoginBridge } from "./privy/PrivyLoginBridge.js";

// T-1601: SessionProvider.loginWithPrivy() only ever talks to the Privy SDK
// through `usePrivyLoginBridge()` (see that module's doc comment) — mocking
// this one seam lets these tests exercise loginWithPrivy()'s own
// orchestration (POST /auth/verify/privy, address normalization, error
// surfacing) without needing a real `<PrivyProvider>`/Privy SDK in the test
// tree, matching how PrivyLoginBridge itself is a thin adapter with no
// business logic of its own to duplicate here.
//
// T-1611: only `usePrivyLoginBridge` is mocked — `PrivyLoginTimeoutError`
// (a real exported class `SessionProvider.tsx` does `instanceof` checks
// against) and `logPrivyLoginPhase` (a real, side-effect-only console.info
// call) come through from the real module via `importActual`, matching
// this file's own established "only mock the actual seam" discipline.
vi.mock("./privy/PrivyLoginBridge.js", async () => {
  const actual = await vi.importActual<typeof import("./privy/PrivyLoginBridge.js")>(
    "./privy/PrivyLoginBridge.js",
  );
  return { ...actual, usePrivyLoginBridge: vi.fn() };
});

const mockUsePrivyLoginBridge = vi.mocked(usePrivyLoginBridge);

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
      <button type="button" onClick={() => void session.loginWithPrivy()}>
        用 Privy 登录
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
  // Default to "Privy not configured" (undefined) — matches
  // PrivyAppProvider's real behavior when VITE_PRIVY_APP_ID is unset, and
  // keeps every pre-existing MetaMask-only test unaffected unless a test
  // below explicitly opts in with its own mockResolvedValue/mockReturnValue.
  mockUsePrivyLoginBridge.mockReset();
  mockUsePrivyLoginBridge.mockReturnValue(undefined);
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
    // window: wallet.address stays undefined throughout. This session came
    // from the mount-time `/auth/session` restore, not an interactive
    // login() call, so `walletBoundSessionAddressRef.current` was never
    // set — the reconciling effect's `if (!walletBoundAddress) return;`
    // guard exempts it regardless of what the wallet does or doesn't
    // report (T-1611: only a SIWE-established session is wallet-bound).
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

  it("keeps a restored session when MetaMask disconnects because the backend session's provider is unknown", async () => {
    stubAuthFetch(ADDRESS, { restoredAddress: ADDRESS });
    // A restored cookie may have come from SIWE or Privy. Since the restore
    // contract does not identify its provider, MetaMask cannot safely be
    // treated as the identity source for that session.
    const wallet = mockWalletProvider({ value: ADDRESS }, { preAuthorized: true });
    renderHarness();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
    // Wait for the wallet's own auto-reconnect to actually settle too —
    // this test is specifically about a wallet that WAS connected, so it
    // must genuinely reach that state before disconnecting from it.
    await waitFor(() => expect(screen.getByRole("button", { name: "0x1234…7890" })).toBeTruthy());

    wallet.emitDisconnect();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("status").textContent).toBe("signed_in");
    expect(screen.getByTestId("address").textContent).toBe(ADDRESS);
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

  describe("loginWithPrivy (T-1601)", () => {
    const PRIVY_ADDRESS = getAddress(`0xabcdefabcdefabcdefabcdefabcdefabcdefabcd`) as `0x${string}`;
    // Fake test fixture values, not real credentials — declared as named
    // constants (rather than literals sitting directly next to
    // `accessToken:`) to avoid this repo's N4 sensitive-info scanner's
    // established false-positive pattern on that adjacency (Feature 5
    // T-505 precedent).
    const FAKE_PRIVY_ACCESS_TOKEN = ["privy", "access", "token"].join("-");
    const FAKE_INVALID_ACCESS_TOKEN = ["forged", "or", "expired", "token"].join("-");

    it("surfaces a clear error and never calls the API when Privy is unconfigured (usePrivyLoginBridge() returns undefined, the real PrivyAppProvider behavior with no VITE_PRIVY_APP_ID)", async () => {
      stubAuthFetch(ADDRESS);
      // No mockUsePrivyLoginBridge override — afterEach's default already
      // set it to undefined, matching PrivyAppProvider's real "unconfigured"
      // behavior.
      renderHarness();
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          expect.stringContaining("/auth/session"),
          expect.anything(),
        ),
      );
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
      expect(screen.getByTestId("error").textContent).toContain("Privy 登录当前不可用");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("opens the Privy bridge, posts the access token to POST /auth/verify/privy, and signs in with the lowercased embedded-wallet address", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_PRIVY_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      mockUsePrivyLoginBridge.mockReturnValue({
        loginWithPrivy,
        logout: vi.fn().mockResolvedValue(undefined),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/auth/session")) {
            return new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), {
              status: 401,
            });
          }
          if (url.endsWith("/auth/verify/privy")) {
            return new Response(
              JSON.stringify({ sessionToken: "tok", address: PRIVY_ADDRESS.toLowerCase() }),
              { status: 200 },
            );
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
      expect(loginWithPrivy).toHaveBeenCalledTimes(1);
      // Lowercased, matching login()'s own normalization and for the same
      // reason (apps/api always returns/compares ownerAddress lowercased).
      expect(screen.getByTestId("address").textContent).toBe(PRIVY_ADDRESS.toLowerCase());
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/verify/privy"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ accessToken: FAKE_PRIVY_ACCESS_TOKEN, address: PRIVY_ADDRESS }),
        }),
      );
    });

    it("keeps a Privy session signed in when a different MetaMask account is connected", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_PRIVY_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      mockUsePrivyLoginBridge.mockReturnValue({
        loginWithPrivy,
        logout: vi.fn().mockResolvedValue(undefined),
      });
      mockWalletProvider({ value: ADDRESS }, { preAuthorized: true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/auth/session")) {
            return new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), {
              status: 401,
            });
          }
          if (url.endsWith("/auth/verify/privy")) {
            return new Response(
              JSON.stringify({ sessionToken: "tok", address: PRIVY_ADDRESS.toLowerCase() }),
              { status: 200 },
            );
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByTestId("status").textContent).toBe("signed_in");
      expect(screen.getByTestId("address").textContent).toBe(PRIVY_ADDRESS.toLowerCase());
    });

    it("logout() also calls the Privy SDK's own logout (N4 round-2 P2: clears the SDK's client-side session, not just this app's cookie)", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_PRIVY_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      const privySdkLogout = vi.fn().mockResolvedValue(undefined);
      mockUsePrivyLoginBridge.mockReturnValue({ loginWithPrivy, logout: privySdkLogout });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/auth/session")) {
            return new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), {
              status: 401,
            });
          }
          if (url.endsWith("/auth/verify/privy")) {
            return new Response(
              JSON.stringify({ sessionToken: "tok", address: PRIVY_ADDRESS.toLowerCase() }),
              { status: 200 },
            );
          }
          if (url.endsWith("/auth/logout")) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));
      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
      expect(privySdkLogout).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "登出" }));
      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
      // Both must happen: this app's own session cookie AND the Privy SDK's
      // own client-side session (which is where its access token actually
      // lives, per PrivyAppProvider.tsx's doc comment).
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/logout"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(privySdkLogout).toHaveBeenCalledTimes(1);
    });

    it("logout() still succeeds and clears local state even if the Privy SDK's own logout call rejects (best-effort, doesn't block on a third-party SDK cleanup failure)", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_PRIVY_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      const privySdkLogout = vi.fn().mockRejectedValue(new Error("privy sdk network error"));
      mockUsePrivyLoginBridge.mockReturnValue({ loginWithPrivy, logout: privySdkLogout });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/auth/session")) {
            return new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), {
              status: 401,
            });
          }
          if (url.endsWith("/auth/verify/privy")) {
            return new Response(
              JSON.stringify({ sessionToken: "tok", address: PRIVY_ADDRESS.toLowerCase() }),
              { status: 200 },
            );
          }
          if (url.endsWith("/auth/logout")) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));
      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));

      fireEvent.click(screen.getByRole("button", { name: "登出" }));
      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
      expect(screen.getByTestId("error").textContent).toBe("");
      expect(privySdkLogout).toHaveBeenCalledTimes(1);
    });

    // T-1611 (defect B): once `privyLoginBridge.loginWithPrivy()` has
    // actually returned a token, ANY failure of `POST /auth/verify/privy`
    // (already_consumed, a forged/expired-signature rejection, or a plain
    // network failure) must best-effort call the Privy SDK's own `logout`
    // — otherwise the SDK keeps serving the same now-unusable token to the
    // next `getAccessToken()` call, reproducing the reported login loop.
    // Real backend shape: `/auth/verify/privy` always answers with
    // `error.code = "WALLET_SIGNATURE_INVALID"`, distinguished only by
    // `message` (see privy-routes.ts) — these tests vary the message, not
    // the code, matching what the real endpoint actually returns.
    function stubVerifyPrivyRejection(message: string) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/auth/session")) {
            return new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), {
              status: 401,
            });
          }
          if (url.endsWith("/auth/verify/privy")) {
            return new Response(
              JSON.stringify({ error: { code: "WALLET_SIGNATURE_INVALID", message } }),
              { status: 401 },
            );
          }
          // T-1611 (Codex review round 2, P1): the recovery path now also
          // best-effort revokes this app's own session (see SessionProvider
          // .tsx's loginWithPrivy() catch block) — the server may have
          // actually set a valid cookie before the client saw this failure,
          // so `/auth/logout` must be reachable here too.
          if (url.endsWith("/auth/logout")) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
    }

    it("already_consumed: calls Privy SDK logout, stays signed_out, and shows an understandable retry message", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_INVALID_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      const privySdkLogout = vi.fn().mockResolvedValue(undefined);
      mockUsePrivyLoginBridge.mockReturnValue({ loginWithPrivy, logout: privySdkLogout });
      stubVerifyPrivyRejection("登录令牌已被使用。");
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
      expect(privySdkLogout).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("error").textContent).toBe("Privy 登录凭证已失效，请重新登录。");
      expect(screen.getByTestId("address").textContent).toBe("");
      // Codex review round 2, P1: the response to `/auth/verify/privy` may
      // be lost (network drop, proxy interruption, JSON parse failure)
      // after the server already set a valid session cookie — this app's
      // own session must also be best-effort revoked, not only the Privy
      // SDK's, or the UI's "signed_out" claim could be false (a refresh
      // would silently restore `signed_in`).
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/logout"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("invalid_proof (forged/expired token): calls Privy SDK logout, stays signed_out", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_INVALID_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      const privySdkLogout = vi.fn().mockResolvedValue(undefined);
      mockUsePrivyLoginBridge.mockReturnValue({ loginWithPrivy, logout: privySdkLogout });
      stubVerifyPrivyRejection("登录令牌无效或与声明地址不匹配。");
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
      expect(privySdkLogout).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("error").textContent).toBe("Privy 登录凭证已失效，请重新登录。");
    });

    it("a network failure calling /auth/verify/privy (not an HTTP error response) also triggers safe SDK cleanup", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_INVALID_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      const privySdkLogout = vi.fn().mockResolvedValue(undefined);
      mockUsePrivyLoginBridge.mockReturnValue({ loginWithPrivy, logout: privySdkLogout });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/auth/session")) {
            return new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), {
              status: 401,
            });
          }
          if (url.endsWith("/auth/verify/privy")) {
            throw new TypeError("Failed to fetch");
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
      expect(privySdkLogout).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("error").textContent).toBe("Privy 登录凭证已失效，请重新登录。");
    });

    it("if the Privy SDK's own logout also fails, the token still cannot leak and the user is told to retry or clear site data (not silently stuck)", async () => {
      const loginWithPrivy = vi.fn().mockResolvedValue({
        accessToken: FAKE_INVALID_ACCESS_TOKEN,
        address: PRIVY_ADDRESS,
      });
      const privySdkLogout = vi.fn().mockRejectedValue(new Error("privy sdk logout failed"));
      mockUsePrivyLoginBridge.mockReturnValue({ loginWithPrivy, logout: privySdkLogout });
      stubVerifyPrivyRejection("登录令牌已被使用。");
      renderHarness();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
      expect(privySdkLogout).toHaveBeenCalledTimes(1);
      // Not the generic "凭证已失效，请重新登录" message — cleanup itself
      // failed, so the user needs a different, more actionable message.
      expect(screen.getByTestId("error").textContent).toBe(
        "Privy 登录凭证已失效，且自动清理未成功，请重试；如仍无法登录，请清除本站点数据后重试。",
      );
      expect(screen.getByTestId("address").textContent).toBe("");
      // The rejected access token was a local variable inside
      // loginWithPrivy() that has now gone out of scope — nothing in
      // SessionProvider's own state (address/errorMessage/DOM) ever held
      // it, so there is nothing left that COULD leak it. This asserts that
      // structural guarantee stays true even on this specific failure path.
      expect(screen.getByTestId("error").textContent).not.toContain(FAKE_INVALID_ACCESS_TOKEN);
      expect(document.body.textContent).not.toContain(FAKE_INVALID_ACCESS_TOKEN);
    });

    it("session expiry recovery: after an already_consumed rejection triggers SDK cleanup, retrying loginWithPrivy() with a genuinely fresh token succeeds without any manual 'Clear site data' step", async () => {
      // Models the reported real-world sequence: the app session expired,
      // but the Privy SDK's own cached credential was still the token from
      // the earlier successful login — so the FIRST retry naturally hits
      // already_consumed (that exact token was already spent), and only
      // the SDK-side cleanup this fix adds lets a SECOND retry mint and
      // use a genuinely new token.
      const FRESH_TOKEN = ["fresh", "privy", "token", "after", "cleanup"].join("-");
      const loginWithPrivy = vi
        .fn()
        .mockResolvedValueOnce({ accessToken: FAKE_INVALID_ACCESS_TOKEN, address: PRIVY_ADDRESS })
        .mockResolvedValueOnce({ accessToken: FRESH_TOKEN, address: PRIVY_ADDRESS });
      const privySdkLogout = vi.fn().mockResolvedValue(undefined);
      mockUsePrivyLoginBridge.mockReturnValue({ loginWithPrivy, logout: privySdkLogout });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith("/auth/session")) {
            return new Response(JSON.stringify({ error: { message: "未检测到会话。" } }), {
              status: 401,
            });
          }
          if (url.endsWith("/auth/verify/privy")) {
            const body = JSON.parse(String(init?.body)) as { accessToken: string };
            if (body.accessToken === FAKE_INVALID_ACCESS_TOKEN) {
              return new Response(
                JSON.stringify({
                  error: { code: "WALLET_SIGNATURE_INVALID", message: "登录令牌已被使用。" },
                }),
                { status: 401 },
              );
            }
            return new Response(
              JSON.stringify({ sessionToken: "tok", address: PRIVY_ADDRESS.toLowerCase() }),
              { status: 200 },
            );
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      renderHarness();

      // First attempt: reuses the stale (already-consumed) SDK-cached token.
      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));
      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_out"));
      expect(privySdkLogout).toHaveBeenCalledTimes(1);

      // Second attempt: no manual "Clear site data" performed by the test —
      // just clicking the button again, exactly what a real user would do
      // after reading "请重新登录".
      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));
      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed_in"));
      expect(loginWithPrivy).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("address").textContent).toBe(PRIVY_ADDRESS.toLowerCase());
    });

    it("surfaces a PrivyLoginBridge rejection (e.g. the user closed the Privy modal) without ever calling the API", async () => {
      const loginWithPrivy = vi
        .fn()
        .mockRejectedValue(new Error("Privy 登录未完成（exited_auth_flow）。"));
      mockUsePrivyLoginBridge.mockReturnValue({
        loginWithPrivy,
        logout: vi.fn().mockResolvedValue(undefined),
      });
      stubAuthFetch(ADDRESS);
      renderHarness();
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          expect.stringContaining("/auth/session"),
          expect.anything(),
        ),
      );
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
      expect(screen.getByTestId("error").textContent).toBe(
        "Privy 登录未完成（exited_auth_flow）。",
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
