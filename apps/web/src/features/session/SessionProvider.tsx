import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HexAddress } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { apiFetch, ApiError } from "../../shared/api/client.js";
import { buildSignInMessage } from "./signInMessage.js";
import { toUserFacingError } from "../../shared/errors/toUserFacingError.js";
import {
  usePrivyLoginBridge,
  PrivyLoginTimeoutError,
  logPrivyLoginPhase,
} from "./privy/PrivyLoginBridge.js";

export type SessionStatus = "signed_out" | "signing_in" | "signed_in" | "error";

export interface SessionContextValue {
  status: SessionStatus;
  /** The address a session was actually established for — only set while
   * `status === "signed_in"`. Distinct from `useWallet().address`: the
   * wallet can switch accounts after a successful login (see the
   * reconciling effect below), at which point this goes back to
   * `undefined` even though the wallet still reports a connected address. */
  address: HexAddress | undefined;
  errorMessage: string | undefined;
  /** Existing MetaMask/SIWE login path (Feature 4/T-1600) — unchanged
   * name and semantics; F-1601's Privy option is deliberately a SEPARATE
   * method (`loginWithPrivy`, below) rather than a rename or a parameter on
   * this one, so every existing caller/test of `login()` keeps working
   * unmodified while both identity providers stay permanently available
   * side by side (user-confirmed: not a migrate-then-deprecate plan). */
  login: () => Promise<void>;
  /** T-1601: Privy embedded-wallet login (ADR-0002). Opens Privy's own
   * login UI via `PrivyLoginBridge`, then posts the resulting access token
   * to `POST /auth/verify/privy` — same tail as `login()`'s
   * nonce/sign/verify flow (address normalization, `signed_in` status),
   * just a different proof-acquisition step up front. Resolves to the same
   * user-visible states (`signing_in` -> `signed_in` | `error`) as
   * `login()`, so `SignInButton` can render both with the same state
   * machine. */
  loginWithPrivy: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

function authDomain(): string {
  return import.meta.env.VITE_AUTH_DOMAIN ?? "localhost";
}

interface NonceResponse {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return toUserFacingError(error, "登录失败，请重试。");
}

/**
 * Thin client-side wrapper around Feature 4's already-shipped sign-in
 * protocol (`POST /auth/nonce` → sign → `POST /auth/verify`) — this module
 * owns no auth logic of its own, it only orchestrates the existing
 * endpoints plus `useWallet().signMessage`. `app.requireSession` itself
 * (the backend interface Feature 5-10 build against) is untouched.
 *
 * On mount, checks whether the httpOnly cookie from an earlier visit is
 * still valid server-side via `GET /auth/session` (Task E manual
 * verification: a page refresh was forcing a re-signature even though the
 * cookie was still good) — reuses the exact same `app.requireSession`
 * preHandler every protected route already relies on, so this adds no new
 * "is a session valid" logic, only a read of what that check already
 * decides. A 401 (no cookie, or expired/revoked) is treated as ordinary
 * `signed_out`, not an error — a first-time visitor with no cookie yet is
 * not a failure.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  // A plain `useContext` read (see PrivyLoginBridge.tsx's doc comment) —
  // `undefined` whenever no `PrivyLoginBridge` ancestor is mounted (Privy
  // unconfigured, or a test harness exercising only the MetaMask path).
  // Always safe to call unconditionally, unlike the Privy SDK's own hooks.
  const privyLoginBridge = usePrivyLoginBridge();
  const [status, setStatus] = useState<SessionStatus>("signed_out");
  const [signedInAddress, setSignedInAddress] = useState<HexAddress | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  // Only a session established by this tab's SIWE flow is bound to the
  // currently connected browser wallet. Privy sessions use their embedded
  // wallet, and restored sessions do not expose their provider, so comparing
  // either of those to MetaMask would incorrectly sign the user out.
  const walletBoundSessionAddressRef = useRef<HexAddress | undefined>(undefined);

  // N4 review (P2): the mount-time restore below is a single one-shot
  // fetch with no natural way to "cancel" it against a *newer* session
  // action the user took while it was still in flight (unmounting is not
  // the only way it can go stale — login()/logout() completing first are
  // real races too, not just a hypothetical). Bumped synchronously at the
  // START of both login() and logout() (before their own async work even
  // begins) so the restore below can detect "something newer already
  // happened" and skip applying its now-stale result, rather than
  // clobbering a fresh login's address or resurrecting a session the user
  // just revoked via logout().
  const sessionActionVersionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const versionAtMount = sessionActionVersionRef.current;
    void apiFetch<{ address: HexAddress }>("/auth/session")
      .then((result) => {
        if (cancelled || sessionActionVersionRef.current !== versionAtMount) return;
        setSignedInAddress(result.address.toLowerCase() as HexAddress);
        setStatus("signed_in");
      })
      .catch(() => {
        // 401 (no session, expired, or revoked) is the ordinary
        // "nothing to restore" case, not an error to surface — status
        // simply stays at its initial `signed_out`.
      });
    return () => {
      cancelled = true;
    };
    // Runs once on mount only — must NOT depend on `wallet`/`status`, or
    // this would refire on every wallet identity change instead of only
    // checking the pre-existing cookie once at load.
  }, []);

  const login = useCallback(async () => {
    // Supersede the mount-time restore above (see its own doc comment) —
    // an explicit login attempt is always more authoritative than a
    // background restore still in flight, whether this succeeds or not.
    sessionActionVersionRef.current += 1;
    if (!wallet.address) {
      setStatus("error");
      setErrorMessage("请先连接 MetaMask 钱包，再登录。");
      return;
    }
    const address = wallet.address;
    setStatus("signing_in");
    setErrorMessage(undefined);
    try {
      const nonceResponse = await apiFetch<NonceResponse>("/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      const message = buildSignInMessage({
        domain: authDomain(),
        address,
        nonce: nonceResponse.nonce,
        issuedAt: new Date(nonceResponse.issuedAt),
        expiresAt: new Date(nonceResponse.expiresAt),
      });
      const signature = await wallet.signMessage(message);
      await apiFetch("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, signature, nonce: nonceResponse.nonce }),
      });
      // Codex review (T-505 round 1, P1): the wallet returns an EIP-55
      // checksummed (mixed-case) address, but apps/api always normalizes
      // ownerAddress to lowercase (nonce.store.ts's normalizeAddress) before
      // returning it. AgentDetailPage/AgentEditPage compare
      // `session.address === agent.ownerAddress` with strict equality —
      // storing the checksummed form here would make that comparison fail
      // for any address containing uppercase hex digits, hiding the
      // edit/activate/deactivate controls from the actual owner. Normalize
      // here, once, at the session boundary, matching what the API returns.
      setSignedInAddress(address.toLowerCase() as HexAddress);
      walletBoundSessionAddressRef.current = address.toLowerCase() as HexAddress;
      setStatus("signed_in");
    } catch (error) {
      setStatus("error");
      setErrorMessage(loginErrorMessage(error));
    }
  }, [wallet]);

  const loginWithPrivy = useCallback(async () => {
    // Supersede the mount-time restore above, same reasoning as login().
    sessionActionVersionRef.current += 1;
    if (!privyLoginBridge) {
      setStatus("error");
      setErrorMessage("Privy 登录当前不可用（未配置），请使用 MetaMask 登录。");
      return;
    }
    setStatus("signing_in");
    setErrorMessage(undefined);
    // `accessToken` is a local variable for the lifetime of this async call
    // only — never assigned to any component state, matching the threat
    // model's "临时使用、用完即弃" mitigation (风险清单 row 1). Declared
    // outside the try below so the catch can tell "never got a token"
    // (nothing to clean up) apart from "got a token, backend rejected it"
    // (T-1611: the SDK is still holding that now-unusable token and MUST be
    // told to drop it — otherwise the next loginWithPrivy() call reuses the
    // same already_consumed/invalid token via getAccessToken()'s cache,
    // reproducing the exact login loop this fix addresses).
    let obtainedToken = false;
    const startedAtMs = Date.now();
    try {
      const { accessToken, address } = await privyLoginBridge.loginWithPrivy();
      obtainedToken = true;
      await apiFetch("/auth/verify/privy", {
        method: "POST",
        body: JSON.stringify({ accessToken, address }),
      });
      logPrivyLoginPhase("backend_verified", startedAtMs);
      // Same normalization as login() below, and for the same reason:
      // apps/api always returns/compares ownerAddress lowercased.
      setSignedInAddress(address.toLowerCase() as HexAddress);
      walletBoundSessionAddressRef.current = undefined;
      setStatus("signed_in");
    } catch (error) {
      if (error instanceof PrivyLoginTimeoutError) {
        // T-1611 (real defect, user-reproduced): the login flow itself
        // never settled (neither onComplete nor onError, no reactive state
        // change either) — PrivyLoginBridge's own timeout already
        // best-effort cleaned up the SDK session, so this app must recover
        // to signed_out (not stay in signing_in, and not a bare "error"
        // that gives no actionable next step) rather than call
        // privyLoginBridge.logout() a second time for a token that was
        // never even obtained here.
        setStatus("signed_out");
        setSignedInAddress(undefined);
        setErrorMessage(loginErrorMessage(error));
        return;
      }
      if (!obtainedToken) {
        // Never reached the backend at all (modal closed, no embedded
        // wallet, SDK didn't return a token) — nothing Privy-side to clean
        // up, same handling as before this fix.
        setStatus("error");
        setErrorMessage(loginErrorMessage(error));
        return;
      }
      // A real token was obtained but `POST /auth/verify/privy` rejected it
      // OR its outcome is unknown (already_consumed, invalid_proof, or a
      // network failure — the last of these three has a real gap a Codex
      // review caught, round 2 P1: the request may have reached the server
      // and the server may have ALREADY set a valid session cookie before
      // the response itself was lost to a dropped connection/proxy
      // interruption/JSON parse failure. Showing `signed_out` without also
      // attempting to revoke that possibly-real backend session would let
      // the UI claim "logged out" while the browser still holds a working
      // session cookie — a page refresh would silently restore
      // `signed_in`). Both cleanups are therefore attempted, independently
      // and best-effort: revoke this app's own session (matches `logout()`
      // below's identical `/auth/logout` call, reused here for the same
      // reason — an outcome-unknown state must be treated as "may already
      // be signed in" until proven otherwise) AND clean up the Privy SDK's
      // client-side session (requirement 1) — this specific token must not
      // be reused regardless of which of the two cleanups succeeds. A
      // failure here must not leak the token (it already can't — it's a
      // local const going out of scope now) and must not crash this catch.
      await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
      try {
        await privyLoginBridge.logout();
        setStatus("signed_out");
        setSignedInAddress(undefined);
        setErrorMessage("Privy 登录凭证已失效，请重新登录。");
      } catch {
        // SDK-side cleanup itself failed — still not signed in on this
        // client (both cleanups were attempted; whichever succeeded is
        // enough to make the browser's actual state match "signed out"),
        // but automatic recovery didn't fully succeed, so say so explicitly
        // rather than silently leaving a stale SDK session for the next
        // attempt to trip over again (requirement 4).
        setStatus("signed_out");
        setSignedInAddress(undefined);
        setErrorMessage(
          "Privy 登录凭证已失效，且自动清理未成功，请重试；如仍无法登录，请清除本站点数据后重试。",
        );
      }
    }
  }, [privyLoginBridge]);

  const logout = useCallback(async () => {
    // Supersede the mount-time restore above, same reasoning as login().
    sessionActionVersionRef.current += 1;
    // Codex review (T-505 round 2, P2): clearing local state in a `finally`
    // regardless of outcome would report "signed out" even when
    // `/auth/logout` itself failed (network error, server 5xx) — the
    // session cookie is still valid server-side in that case, so the UI
    // would be lying about being logged out while the session can still
    // authenticate requests. Only clear local state after the server
    // actually confirms revocation; surface the failure otherwise so the
    // user can retry rather than believing they're safely logged out.
    try {
      await apiFetch("/auth/logout", { method: "POST" });
      setSignedInAddress(undefined);
      walletBoundSessionAddressRef.current = undefined;
      setStatus("signed_out");
      setErrorMessage(undefined);
    } catch (error) {
      setErrorMessage(loginErrorMessage(error));
      throw error;
    }
    // N4 round-2 finding (T-1601, P2): revoking this project's own session
    // cookie above does not touch the Privy SDK's own client-side session —
    // without this, a Privy-authenticated user still has a live, silently-
    // reusable Privy session in browser storage after "logging out" of this
    // app. Called unconditionally after the backend confirms revocation
    // (which is the security-critical half — matches this function's
    // existing "only clear local state once the server confirms" ordering)
    // and best-effort: it runs whether this tab's session came from
    // MetaMask or Privy (a no-op if the user never used Privy), and a
    // failure here doesn't reopen the already-confirmed backend logout or
    // surface as session.errorMessage — there's nothing the user can
    // meaningfully retry for a third-party SDK's own local cleanup.
    if (privyLoginBridge) {
      await privyLoginBridge.logout().catch(() => undefined);
    }
  }, [privyLoginBridge]);

  // The wallet switching to a different account (or genuinely
  // disconnecting) after login invalidates this session's client-visible
  // "signed in" status (AC-505's ownership checks compare against the
  // SESSION's address, not whatever the wallet currently shows) — the old
  // session cookie is untouched server-side, but continuing to show
  // "signed in" next to a now-different (or now-absent) connected address
  // would be misleading, and any subsequent mutating call for the new
  // address needs its own login. Does not call /auth/logout: the old
  // session is simply no longer what this UI is acting as.
  useEffect(() => {
    if (status !== "signed_in") return;
    const walletBoundAddress = walletBoundSessionAddressRef.current;
    if (!walletBoundAddress) return;

    if (wallet.address !== undefined) {
      // Compare lowercased on both sides: `signedInAddress` is always
      // lowercase (see login() above) but `wallet.address` is whatever
      // casing the wallet itself reports (typically EIP-55 checksummed) —
      // a naive strict comparison would treat "still the same account" as
      // a switch on every render, immediately signing the user back out.
      if (wallet.address.toLowerCase() !== walletBoundAddress) {
        setSignedInAddress(undefined);
        walletBoundSessionAddressRef.current = undefined;
        setStatus("signed_out");
      }
      return;
    }
    setSignedInAddress(undefined);
    walletBoundSessionAddressRef.current = undefined;
    setStatus("signed_out");
  }, [wallet.address, signedInAddress, status]);

  const value = useMemo<SessionContextValue>(
    () => ({ status, address: signedInAddress, errorMessage, login, loginWithPrivy, logout }),
    [status, signedInAddress, errorMessage, login, loginWithPrivy, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return session;
}
