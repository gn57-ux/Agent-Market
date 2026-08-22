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
      setSignedInAddress(address);
      setStatus("signed_in");
    } catch (error) {
      setStatus("error");
      setErrorMessage(loginErrorMessage(error));
    }
  }, [wallet]);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } finally {
      setSignedInAddress(undefined);
      setStatus("signed_out");
      setErrorMessage(undefined);
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
    if (status === "signed_in" && wallet.address !== signedInAddress) {
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
