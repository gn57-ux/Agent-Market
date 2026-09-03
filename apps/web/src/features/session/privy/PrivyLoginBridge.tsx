import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useLogin, usePrivy, type User } from "@privy-io/react-auth";
import type { HexAddress } from "@agent-market/domain";

export interface PrivyLoginResult {
  /**
   * Privy's short-lived access token (JWT). Consumed exactly once by
   * `SessionProvider.loginWithPrivy()`'s single `POST /auth/verify/privy`
   * call and then dropped — this module and `SessionProvider` never assign
   * it to component state, `sessionStorage`, or `localStorage` of their
   * own. See the threat model's residual-risk entry on token storage
   * (`docs/security/privy-embedded-wallet-threat-model.md`, 风险清单 row 1)
   * and `PrivyAppProvider.tsx`'s doc comment for what the Privy SDK itself
   * still does with this token independently of this project's code.
   */
  accessToken: string;
  address: HexAddress;
}

/**
 * T-1611 (real defect, user-reproduced 2026-09-03): a real Privy login,
 * after real OTP completion, stayed on "登录中…" permanently — the app
 * never received either `onComplete` or `onError`, and a page refresh
 * still showed no established session. Root cause, verified against the
 * actually-installed SDK (`@privy-io/react-auth` 3.39.0)'s own type
 * declarations, not assumed from memory:
 * `PrivyEvents['login'].onComplete`'s doc comment states it only fires
 * once the user "successfully authenticates _and_ creates their wallet
 * (if applicable)" when `config.embeddedWallets.ethereum.createOnLogin`
 * is `"users-without-wallets"` — which is exactly `PrivyAppProvider.tsx`'s
 * real config. Wallet creation is therefore a separate, SDK-internal step
 * AFTER authentication, and it can stall (network conditions reaching
 * Privy's own wallet infra, etc.) without ever firing `onComplete` or
 * `onError` — there was previously no other completion source and no
 * timeout, so `pendingRef` — and therefore `SessionProvider`'s
 * `"signing_in"` status — could wait forever.
 *
 * Fixed with two independent completion sources plus a hard ceiling:
 * (1) `useLogin`'s own `onComplete`/`onError` callbacks (unchanged,
 *     still the richest/fastest path when they do fire);
 * (2) reactively watching `usePrivy()`'s own `ready`/`authenticated`/
 *     `user` state — the SDK updates this regardless of whether the
 *     imperative callbacks fire, so this bridge no longer depends solely
 *     on them (also directly covers "already-authenticated user calls
 *     login() again", checked synchronously the moment a login starts,
 *     not only via a later effect re-run);
 * (3) `PRIVY_LOGIN_TIMEOUT_MS` — if neither source settles the pending
 *     promise in time, the flow is force-rejected, the Privy SDK's own
 *     session is best-effort cleaned up (`logout()`), and the timeout
 *     rejection is a distinguishable `PrivyLoginTimeoutError` so
 *     `SessionProvider` can recover to `signed_out` with an actionable
 *     message rather than getting stuck in `error` forever either.
 */
const PRIVY_LOGIN_TIMEOUT_MS = 90_000;

/**
 * T-1611: thrown only when `PRIVY_LOGIN_TIMEOUT_MS` elapses with no
 * completion from either source above. `SessionProvider` checks for this
 * specific type (not just "any rejection") because the timeout path has
 * ALREADY best-effort cleaned up the Privy SDK session inside this module
 * — `SessionProvider` must not treat it as "nothing to clean up" the way
 * it treats a pre-token failure (e.g. the user closing the modal).
 */
export class PrivyLoginTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivyLoginTimeoutError";
  }
}

export type PrivyLoginPhase =
  "modal_started" | "sdk_authenticated" | "wallet_resolved" | "token_obtained" | "backend_verified";

/**
 * T-1611 requirement 1: redacted phase/timing log only — never the
 * address, token, OTP, or any request body (only a phase name and an
 * elapsed-ms integer are ever passed here). Exported so `SessionProvider`
 * can log its own `"backend_verified"` phase through the same, single
 * formatting rule rather than inventing a second one.
 */
export function logPrivyLoginPhase(phase: PrivyLoginPhase, startedAtMs: number): void {
  console.info(`[privy-login] phase=${phase} elapsedMs=${Date.now() - startedAtMs}`);
}

interface PrivyLoginBridgeValue {
  loginWithPrivy: () => Promise<PrivyLoginResult>;
  /**
   * N4 round-2 finding (T-1601 spec review, P2): F-1601 requires the
   * identity-provider abstraction to support "注销" (logout), and this
   * project's actual logout path (`SessionProvider.logout()` -> `POST
   * /auth/logout`) only ever revoked this project's own session cookie —
   * it never told the Privy SDK itself to drop its client-side session.
   * `usePrivy().logout` is what actually clears the SDK's own
   * localStorage-held access token (see `PrivyAppProvider.tsx`'s doc
   * comment on where that token really lives); without calling it, a user
   * who logs out of this app still has a live, silently-reusable Privy
   * session sitting in their browser storage — exactly the kind of
   * leftover credential the threat model's frontend-compromise risk (风险
   * 清单 row 1) warns about.
   */
  logout: () => Promise<void>;
}

const PrivyLoginContext = createContext<PrivyLoginBridgeValue | undefined>(undefined);

/**
 * `undefined` whenever no `PrivyLoginBridge` ancestor is mounted — either
 * because `VITE_PRIVY_APP_ID` isn't configured (see `PrivyAppProvider`) or,
 * in a test harness, because the test only exercises the MetaMask path.
 * This is a plain React `useContext` call, never `usePrivy()`/`useLogin()`
 * directly, so it is always safe for `SessionProvider` to call
 * unconditionally regardless of whether a real `<PrivyProvider>` is
 * mounted anywhere in the tree (calling the SDK's own hooks without that
 * ancestor throws — see `PrivyAppProvider.tsx`'s doc comment).
 */
export function usePrivyLoginBridge(): PrivyLoginBridgeValue | undefined {
  return useContext(PrivyLoginContext);
}

function assertEmbeddedWalletAddress(value: string): HexAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("Privy 返回的钱包地址格式无效，请重试。");
  }
  return value as HexAddress;
}

interface PendingLogin {
  resolve: (result: PrivyLoginResult) => void;
  reject: (error: Error) => void;
  startedAtMs: number;
  timeoutId: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/**
 * Bridges the Privy React SDK's callback-shaped `useLogin`
 * (`onComplete`/`onError`, fired whenever the login modal this component
 * opened finishes) into the single-shot `Promise<PrivyLoginResult>`
 * `SessionProvider.loginWithPrivy()` wants — the same async idiom the
 * existing MetaMask path already uses via `wallet.signMessage`, so
 * `SessionProvider` doesn't need two different shapes side by side for its
 * two login methods.
 *
 * Must be mounted INSIDE a real `<PrivyProvider>` — `PrivyAppProvider.tsx`
 * is the only place that does this, and only when `VITE_PRIVY_APP_ID` is
 * actually configured.
 */
export function PrivyLoginBridge({ children }: { children: ReactNode }) {
  const { getAccessToken, logout: privySdkLogout, ready, authenticated, user } = usePrivy();

  // Holds the single in-flight loginWithPrivy() call's resolve/reject, if
  // any. `useLogin`'s onComplete/onError are plain SDK callbacks, not tied
  // to a particular render, so this must survive across renders (a ref, not
  // state) and must be cleared the moment it's used, so that a later,
  // unrelated login attempt can't resolve/reject a promise that already
  // settled.
  const pendingRef = useRef<PendingLogin | undefined>(undefined);

  const settleResolve = useCallback((result: PrivyLoginResult) => {
    const pending = pendingRef.current;
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timeoutId);
    pendingRef.current = undefined;
    pending.resolve(result);
  }, []);

  const settleReject = useCallback((error: Error) => {
    const pending = pendingRef.current;
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timeoutId);
    pendingRef.current = undefined;
    pending.reject(error);
  }, []);

  // T-1611 requirement 5: a component unmount (or a fresh mount reusing a
  // stale closure) must not leave a promise nobody will ever settle —
  // `SessionProvider`'s own `loginWithPrivy()` would otherwise hang exactly
  // like the original bug, just from a different cause.
  useEffect(() => {
    return () => {
      const pending = pendingRef.current;
      if (pending && !pending.settled) {
        pending.settled = true;
        clearTimeout(pending.timeoutId);
        pendingRef.current = undefined;
        pending.reject(new Error("组件已卸载，登录流程已取消。"));
      }
    };
  }, []);

  // Shared tail for BOTH completion sources below (onComplete callback and
  // the reactive usePrivy() watch) — T-1601's scope is embedded wallet
  // login specifically, not "Privy as a UI in front of an external
  // wallet", so `walletClientType === "privy"` (the SDK's own embedded-
  // wallet marker, verified against @privy-io/react-auth 3.39.0's real
  // `EMBEDDED_WALLET_CLIENT_TYPES = ["privy"]` type export) still gates
  // whether a resolved `user` object actually counts as a completed
  // embedded-wallet login. Returns without doing anything if the wallet
  // isn't populated yet — callers keep waiting (onComplete may still fire
  // later, or a subsequent state change may re-trigger the reactive path).
  const tryCompleteFromUser = useCallback(
    (candidateUser: User | null | undefined) => {
      const pending = pendingRef.current;
      if (!pending || pending.settled) return;
      const wallet = candidateUser?.wallet;
      if (!wallet || wallet.walletClientType !== "privy") return;
      logPrivyLoginPhase("wallet_resolved", pending.startedAtMs);
      void (async () => {
        try {
          const address = assertEmbeddedWalletAddress(wallet.address);
          // Read fresh here and used once by the caller — never stored, see
          // PrivyLoginResult's doc comment.
          const accessToken = await getAccessToken();
          if (!accessToken) {
            settleReject(new Error("Privy 未返回可用的访问令牌，请重试。"));
            return;
          }
          logPrivyLoginPhase("token_obtained", pending.startedAtMs);
          settleResolve({ accessToken, address });
        } catch (error) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    },
    [getAccessToken, settleReject, settleResolve],
  );

  const { login } = useLogin({
    onComplete: ({ user: completedUser }) => {
      const pending = pendingRef.current;
      if (!pending || pending.settled) return;
      // USER_EXITED_AUTH_FLOW (user closed the modal without completing
      // login) lands in onError, not here — SessionProvider gives it the
      // same "signing_in -> error" treatment as any other login failure,
      // no special-casing needed for a cancel.
      logPrivyLoginPhase("sdk_authenticated", pending.startedAtMs);
      tryCompleteFromUser(completedUser);
    },
    onError: (error) => {
      settleReject(new Error(`Privy 登录未完成（${error}）。`));
    },
  });

  // T-1611 requirement 3: reactive fallback — the SDK's own `authenticated`
  // + `user` state can become populated without `onComplete` firing again
  // for a real, reproduced scenario this task cannot fully enumerate from
  // outside the SDK's own internals (see this module's header comment).
  // Watching it directly means this bridge does not depend SOLELY on the
  // imperative callback path for a pending login to ever resolve.
  useEffect(() => {
    if (!ready || !authenticated) return;
    const pending = pendingRef.current;
    if (!pending || pending.settled) return;
    logPrivyLoginPhase("sdk_authenticated", pending.startedAtMs);
    tryCompleteFromUser(user);
  }, [ready, authenticated, user, tryCompleteFromUser]);

  const loginWithPrivy = useCallback((): Promise<PrivyLoginResult> => {
    return new Promise((resolve, reject) => {
      if (pendingRef.current) {
        reject(new Error("已有一个 Privy 登录流程正在进行中，请稍候再试。"));
        return;
      }
      const startedAtMs = Date.now();
      const timeoutId = setTimeout(() => {
        void (async () => {
          const pending = pendingRef.current;
          if (!pending || pending.settled) return;
          // Marked settled immediately so onComplete/onError/the reactive
          // effect can no longer try to settle this same pending while the
          // cleanup below is in flight — but `pendingRef.current` itself
          // stays set (not yet cleared) for the duration of that cleanup.
          pending.settled = true;
          // T-1611 requirement 2 (Codex review round 2, P2): the SDK
          // cleanup must fully finish BEFORE this rejects and
          // `pendingRef` is cleared — a fire-and-forget cleanup (the
          // original version of this fix) let an immediate retry's fresh
          // authentication race against this stale cleanup finishing
          // later, with the old cleanup able to wipe out the NEW session
          // it had nothing to do with — reproducing the exact
          // invalid-credential loop this whole fix exists to close.
          // Keeping `pendingRef.current` set until cleanup completes means
          // a concurrent `loginWithPrivy()` call during this window is
          // refused ("已有一个...请稍候再试") rather than racing.
          await privySdkLogout().catch(() => undefined);
          pendingRef.current = undefined;
          pending.reject(
            new PrivyLoginTimeoutError(
              `Privy 登录超时（超过 ${Math.round(PRIVY_LOGIN_TIMEOUT_MS / 1000)} 秒未完成）。`,
            ),
          );
        })();
      }, PRIVY_LOGIN_TIMEOUT_MS);
      pendingRef.current = { resolve, reject, startedAtMs, timeoutId, settled: false };
      logPrivyLoginPhase("modal_started", startedAtMs);
      login();
      // T-1611 requirement 3 (already-authenticated case): the SDK's own
      // doc comment for onComplete says "If a user is already
      // authenticated, this will run immediately" — but a real reproduced
      // bug showed at least one path where a completion source doesn't
      // fire, so this also checks synchronously right after starting the
      // attempt rather than only relying on a future callback or a future
      // effect re-run (the reactive effect above only re-fires when
      // ready/authenticated/user actually CHANGE, which they will not if
      // the user was already authenticated before this call started).
      if (ready && authenticated) {
        tryCompleteFromUser(user);
      }
    });
  }, [login, ready, authenticated, user, tryCompleteFromUser, privySdkLogout]);

  const value = useMemo<PrivyLoginBridgeValue>(
    () => ({ loginWithPrivy, logout: privySdkLogout }),
    [loginWithPrivy, privySdkLogout],
  );

  return <PrivyLoginContext.Provider value={value}>{children}</PrivyLoginContext.Provider>;
}
