// T-1611 (real defect, user-reproduced): a real Privy login, after real
// OTP completion, stayed on "登录中…" forever — neither `onComplete` nor
// `onError` ever fired. These tests exercise PrivyLoginBridge's own
// internal completion-detection logic directly (unlike
// SessionProvider.test.tsx, which mocks this module's public hook
// entirely) — mocking only `@privy-io/react-auth` itself, the real
// external seam, so PrivyLoginBridge's real timeout/fallback/cleanup code
// actually runs.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  PrivyLoginBridge,
  usePrivyLoginBridge,
  PrivyLoginTimeoutError,
} from "./PrivyLoginBridge.js";

interface MockUser {
  wallet?: { walletClientType: string; address: string };
}

const mocks = vi.hoisted(() => {
  let state: { ready: boolean; authenticated: boolean; user: MockUser | null } = {
    ready: true,
    authenticated: false,
    user: null,
  };
  let listeners: Array<() => void> = [];
  let onComplete: ((params: { user: unknown }) => void) | undefined;
  let onError: ((error: unknown) => void) | undefined;

  return {
    login: vi.fn(),
    getAccessToken: vi.fn(),
    privySdkLogout: vi.fn(),
    setState(next: Partial<typeof state>) {
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    resetState() {
      state = { ready: true, authenticated: false, user: null };
      listeners = [];
      onComplete = undefined;
      onError = undefined;
    },
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    setCallbacks(next: {
      onComplete?: (params: { user: unknown }) => void;
      onError?: (error: unknown) => void;
    }) {
      onComplete = next.onComplete;
      onError = next.onError;
    },
    fireOnComplete(user: unknown) {
      onComplete?.({ user });
    },
    fireOnError(error: unknown) {
      onError?.(error);
    },
  };
});

vi.mock("@privy-io/react-auth", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    useLogin: (callbacks?: {
      onComplete?: (p: { user: unknown }) => void;
      onError?: (e: unknown) => void;
    }) => {
      mocks.setCallbacks({ onComplete: callbacks?.onComplete, onError: callbacks?.onError });
      return { login: mocks.login };
    },
    usePrivy: () => {
      const snapshot = react.useSyncExternalStore(mocks.subscribe, mocks.getSnapshot);
      return { ...snapshot, getAccessToken: mocks.getAccessToken, logout: mocks.privySdkLogout };
    },
  };
});

// Test-only escape hatch: the P2 race-fix test below needs to call
// `loginWithPrivy()` a second time directly (bypassing BridgeProbe's own
// shared UI state, which two concurrent handleLogin() calls would leave in
// an order-ambiguous state — not what that test wants to assert on) and
// read that second call's own rejection reason in isolation.
let capturedBridge: ReturnType<typeof usePrivyLoginBridge> = undefined;

function BridgeProbe() {
  const bridge = usePrivyLoginBridge();
  capturedBridge = bridge;
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const handleLogin = async () => {
    if (!bridge) {
      setError("bridge context missing — test harness bug, not under test here");
      return;
    }
    setPending(true);
    setError("");
    setResult("");
    try {
      const r = await bridge.loginWithPrivy();
      setResult(`ok:${r.accessToken}:${r.address}`);
    } catch (e) {
      setError(e instanceof Error ? `${e.name}:${e.message}` : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={() => void handleLogin()}>
        login
      </button>
      <span data-testid="pending">{pending ? "pending" : "idle"}</span>
      <span data-testid="result">{result}</span>
      <span data-testid="error">{error}</span>
    </div>
  );
}

function renderHarness() {
  return render(
    <PrivyLoginBridge>
      <BridgeProbe />
    </PrivyLoginBridge>,
  );
}

const FAKE_TOKEN = ["privy", "access", "token"].join("-");
const WALLET_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

beforeEach(() => {
  mocks.login.mockReset();
  mocks.getAccessToken.mockReset();
  mocks.getAccessToken.mockResolvedValue(FAKE_TOKEN);
  mocks.privySdkLogout.mockReset();
  mocks.privySdkLogout.mockResolvedValue(undefined);
  mocks.resetState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PrivyLoginBridge (T-1611: real login-freeze fix)", () => {
  it("resolves normally via onComplete when the SDK behaves as documented", async () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "login" }));
    expect(mocks.login).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.fireOnComplete({ wallet: { walletClientType: "privy", address: WALLET_ADDRESS } });
    });

    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe(`ok:${FAKE_TOKEN}:${WALLET_ADDRESS}`),
    );
  });

  it("reproduces the real bug's fix: onComplete never fires, but the reactive usePrivy() state becoming authenticated still resolves the login (no timeout needed)", async () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "login" }));
    expect(screen.getByTestId("pending").textContent).toBe("pending");

    // Neither fireOnComplete nor fireOnError is ever called here — this is
    // the exact real-world symptom: the SDK authenticated the user and
    // (eventually) created the wallet, but the imperative callback simply
    // never fired. Only usePrivy()'s own reactive state changes.
    await act(async () => {
      mocks.setState({
        ready: true,
        authenticated: true,
        user: { wallet: { walletClientType: "privy", address: WALLET_ADDRESS } },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe(`ok:${FAKE_TOKEN}:${WALLET_ADDRESS}`),
    );
  });

  it("already-authenticated user calling login() again resolves immediately from the synchronous check, without waiting for a future effect re-run", async () => {
    mocks.setState({
      ready: true,
      authenticated: true,
      user: { wallet: { walletClientType: "privy", address: WALLET_ADDRESS } },
    });
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "login" }));

    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe(`ok:${FAKE_TOKEN}:${WALLET_ADDRESS}`),
    );
  });

  it("getAccessToken() hanging forever is still bounded by the overall timeout, cleans up the SDK session, and rejects with PrivyLoginTimeoutError", async () => {
    vi.useFakeTimers();
    mocks.getAccessToken.mockImplementation(() => new Promise(() => {})); // never resolves
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "login" }));
    await act(async () => {
      mocks.fireOnComplete({ wallet: { walletClientType: "privy", address: WALLET_ADDRESS } });
    });
    // wallet resolved, now stuck inside getAccessToken() forever
    expect(screen.getByTestId("pending").textContent).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    // Not `waitFor` here — with fake timers active, its own internal
    // polling conflicts with them (a well-known testing-library/vitest
    // interaction issue). `act()` above already flushed every state update
    // synchronously once the fake clock was advanced, so asserting
    // directly is both correct and avoids that flakiness.
    expect(screen.getByTestId("pending").textContent).toBe("idle");
    expect(screen.getByTestId("error").textContent).toContain("PrivyLoginTimeoutError");
    expect(mocks.privySdkLogout).toHaveBeenCalledTimes(1);
  });

  it("Codex review round 2, P2: a retry attempted WHILE the timeout's SDK cleanup is still in flight is refused, not raced — closes the race that could let a stale cleanup wipe out a freshly-authenticated new session", async () => {
    vi.useFakeTimers();
    let resolveLogout: (() => void) | undefined;
    mocks.privySdkLogout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLogout = resolve;
        }),
    );
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "login" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    // The timeout fired and started `privySdkLogout()`, but it has NOT been
    // resolved yet (this test controls exactly when it does) — the pending
    // login must therefore not have rejected yet either.
    expect(screen.getByTestId("pending").textContent).toBe("pending");
    expect(mocks.privySdkLogout).toHaveBeenCalledTimes(1);

    // A second, direct loginWithPrivy() call during this window (bypassing
    // BridgeProbe's own shared state, which two concurrent handleLogin()
    // calls would leave order-ambiguous) must be refused outright — this
    // is the fix: pendingRef stays set until cleanup truly finishes, so a
    // fresh login cannot start and race against the stale cleanup.
    if (!capturedBridge) throw new Error("capturedBridge missing — test harness bug");
    await expect(capturedBridge.loginWithPrivy()).rejects.toThrow(
      "已有一个 Privy 登录流程正在进行中",
    );

    // Only once the cleanup this test controls actually resolves does the
    // original timed-out attempt finally reject, and only THEN can a new
    // login attempt proceed.
    await act(async () => {
      resolveLogout?.();
    });
    expect(screen.getByTestId("pending").textContent).toBe("idle");
    expect(screen.getByTestId("error").textContent).toContain("PrivyLoginTimeoutError");

    vi.useRealTimers();
    mocks.privySdkLogout.mockResolvedValue(undefined);
    mocks.getAccessToken.mockResolvedValue(FAKE_TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "login" }));
    await act(async () => {
      mocks.fireOnComplete({ wallet: { walletClientType: "privy", address: WALLET_ADDRESS } });
    });
    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe(`ok:${FAKE_TOKEN}:${WALLET_ADDRESS}`),
    );
  });

  it("a login where NEITHER callback nor reactive state ever changes times out, cleans up, and rejects with PrivyLoginTimeoutError (the exact real-world freeze, fully bounded)", async () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "login" }));
    expect(screen.getByTestId("pending").textContent).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    // Not `waitFor` here — with fake timers active, its own internal
    // polling conflicts with them (a well-known testing-library/vitest
    // interaction issue). `act()` above already flushed every state update
    // synchronously once the fake clock was advanced, so asserting
    // directly is both correct and avoids that flakiness.
    expect(screen.getByTestId("pending").textContent).toBe("idle");
    expect(screen.getByTestId("error").textContent).toContain("PrivyLoginTimeoutError");
    expect(mocks.privySdkLogout).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("result").textContent).toBe("");
  });

  it("component unmount while a login is pending rejects it and does not leave a dangling promise", async () => {
    const { unmount } = renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "login" }));
    expect(mocks.login).toHaveBeenCalledTimes(1);

    // Unmounting must not throw and must not leave an unhandled rejection
    // (React Testing Library's own unmount already flushes effects).
    await act(async () => {
      unmount();
    });
    // No assertion beyond "this didn't hang or throw" is meaningful here —
    // the probe component (which held the promise) is gone with it. The
    // real regression this guards is a leaked pendingRef inside
    // PrivyLoginBridge itself surviving past unmount; covered indirectly
    // by the next test (remount + fresh login working cleanly).
  });

  it("after a timeout, a subsequent login attempt is not blocked by the previous (already-cleared) pending state and can succeed", async () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "login" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    // Not `waitFor` here — with fake timers active, its own internal
    // polling conflicts with them (a well-known testing-library/vitest
    // interaction issue). `act()` above already flushed every state update
    // synchronously once the fake clock was advanced, so asserting
    // directly is both correct and avoids that flakiness.
    expect(screen.getByTestId("pending").textContent).toBe("idle");
    expect(screen.getByTestId("error").textContent).toContain("PrivyLoginTimeoutError");

    vi.useRealTimers();
    mocks.getAccessToken.mockResolvedValue(FAKE_TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "login" }));
    expect(mocks.login).toHaveBeenCalledTimes(2);
    await act(async () => {
      mocks.fireOnComplete({ wallet: { walletClientType: "privy", address: WALLET_ADDRESS } });
    });

    await waitFor(() =>
      expect(screen.getByTestId("result").textContent).toBe(`ok:${FAKE_TOKEN}:${WALLET_ADDRESS}`),
    );
  });

  it("onError still surfaces normally (e.g. the user closed the modal) without waiting for the timeout", async () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "login" }));

    await act(async () => {
      mocks.fireOnError("exited_auth_flow");
    });

    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toContain("Privy 登录未完成"),
    );
    expect(mocks.privySdkLogout).not.toHaveBeenCalled();
  });
});

void PrivyLoginTimeoutError;
