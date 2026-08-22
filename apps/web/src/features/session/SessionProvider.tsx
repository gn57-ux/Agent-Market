import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { HexAddress } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { apiFetch, ApiError } from "../../shared/api/client.js";
import { buildSignInMessage } from "./signInMessage.js";

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
  if (error instanceof Error) return error.message;
  return "登录失败，请重试。";
}

/**
 * Thin client-side wrapper around Feature 4's already-shipped sign-in
 * protocol (`POST /auth/nonce` → sign → `POST /auth/verify`) — this module
 * owns no auth logic of its own, it only orchestrates the existing
 * endpoints plus `useWallet().signMessage`. `app.requireSession` itself
 * (the backend interface Feature 5-10 build against) is untouched.
 *
 * Deliberately has no "check whether a session cookie from a previous page
 * load is still valid" step (there is no `GET /auth/session` "whoami"
 * endpoint, and adding one is out of Feature 5's scope) — on a fresh page
 * load `status` always starts at `signed_out`, even if the httpOnly cookie
 * from an earlier visit is technically still valid server-side. A user who
 * reloads mid-session sees the sign-in button again and must re-sign; this
 * is a deliberate stage-one simplification, not an oversight.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [status, setStatus] = useState<SessionStatus>("signed_out");
  const [signedInAddress, setSignedInAddress] = useState<HexAddress | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const login = useCallback(async () => {
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

  // The wallet switching to a different account after login invalidates
  // this session's client-visible "signed in" status (AC-505's ownership
  // checks compare against the SESSION's address, not whatever the wallet
  // currently shows) — the old session cookie is untouched server-side,
  // but continuing to show "signed in" next to a now-different connected
  // address would be misleading, and any subsequent mutating call for the
  // new address needs its own login. Does not call /auth/logout: the old
  // session is simply no longer what this UI is acting as.
  useEffect(() => {
    // Compare lowercased on both sides: `signedInAddress` is always
    // lowercase (see login() above) but `wallet.address` is whatever
    // casing the wallet itself reports (typically EIP-55 checksummed) — a
    // naive strict comparison would treat "still the same account" as a
    // switch on every render, immediately signing the user back out.
    if (status === "signed_in" && wallet.address?.toLowerCase() !== signedInAddress) {
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
