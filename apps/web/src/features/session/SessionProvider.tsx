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
  login: () => Promise<void>;
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
  const [status, setStatus] = useState<SessionStatus>("signed_out");
  const [signedInAddress, setSignedInAddress] = useState<HexAddress | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

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
      setStatus("signed_in");
    } catch (error) {
      setStatus("error");
      setErrorMessage(loginErrorMessage(error));
    }
  }, [wallet]);

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
      setStatus("signed_out");
      setErrorMessage(undefined);
    } catch (error) {
      setErrorMessage(loginErrorMessage(error));
      throw error;
    }
  }, []);

  // Tracks whether THIS tab's wallet has ever actually reported a connected
  // address (auto-reconnected, connected via the button, or switched to a
  // new account) — never reset back to false. Distinguishes two situations
  // that both look like "wallet.address is undefined" but need opposite
  // treatment below: a wallet that genuinely DISCONNECTED after having been
  // connected here (this flips true first, so a later undefined is a real
  // transition) vs. one that has simply never connected in this tab at all
  // (this stays false, e.g. no MetaMask installed, or the user hasn't
  // clicked "连接钱包" yet this visit) — the latter is not a "disconnect",
  // it is just "no information yet", and must not override a session the
  // `GET /auth/session` restore above legitimately found still valid
  // server-side (that restore has no dependency on this tab's wallet ever
  // having connected at all).
  const hasWalletEverConnectedRef = useRef(false);

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

    if (wallet.address !== undefined) {
      hasWalletEverConnectedRef.current = true;
      // Compare lowercased on both sides: `signedInAddress` is always
      // lowercase (see login() above) but `wallet.address` is whatever
      // casing the wallet itself reports (typically EIP-55 checksummed) —
      // a naive strict comparison would treat "still the same account" as
      // a switch on every render, immediately signing the user back out.
      if (wallet.address.toLowerCase() !== signedInAddress) {
        setSignedInAddress(undefined);
        setStatus("signed_out");
      }
      return;
    }

    // wallet.address is undefined here. N4 review (P2): earlier this branch
    // treated ANY undefined as a real disconnect, which broke exactly the
    // case this session-restore feature exists for — a still-valid cookie
    // restoring `signed_in` before (or even without) this tab's wallet ever
    // reconnecting is not a contradiction to resolve, it's the intended
    // behavior; only clear if THIS tab's wallet had genuinely been
    // connected and matching before now.
    if (hasWalletEverConnectedRef.current) {
      setSignedInAddress(undefined);
      setStatus("signed_out");
    }
  }, [wallet.address, signedInAddress, status]);

  const value = useMemo<SessionContextValue>(
    () => ({ status, address: signedInAddress, errorMessage, login, logout }),
    [status, signedInAddress, errorMessage, login, logout],
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
