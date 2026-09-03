import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { PrivyLoginBridge } from "./PrivyLoginBridge.js";

/**
 * `VITE_PRIVY_APP_ID` is a public Privy App ID — not a secret, Privy's own
 * frontend SDK requires it to initialize and it is expected to ship inside
 * the browser bundle. `undefined` whenever it's unset, a real and common
 * case for local dev/CI environments that haven't provisioned Privy
 * credentials.
 */
function privyAppId(): string | undefined {
  const id = import.meta.env.VITE_PRIVY_APP_ID;
  return id ? id : undefined;
}

/**
 * Mounts the Privy React SDK only when it is actually configured.
 *
 * Verified directly against the installed SDK (@privy-io/react-auth
 * 3.39.0, via a throwaway jsdom/vitest render probe — not assumed):
 * `<PrivyProvider appId="">` (and `appId={undefined}`) throws
 * SYNCHRONOUSLY during render — "Cannot initialize the Privy provider with
 * an invalid Privy app ID" — it does NOT degrade gracefully on its own.
 * Skipping the mount entirely when unconfigured is therefore this module's
 * own responsibility, not something the SDK provides: every other feature
 * (MetaMask login, task/agent flows) must keep working in an environment
 * with no Privy credentials provisioned, which describes most local dev
 * and CI runs today (`.env.example` ships no `VITE_PRIVY_APP_ID`).
 * `SessionProvider.loginWithPrivy()` reports this state to the user as
 * "Privy 登录当前不可用" via `usePrivyLoginBridge()` returning `undefined`
 * (see `PrivyLoginBridge.tsx`) rather than crashing.
 *
 * `config.embeddedWallets.ethereum.createOnLogin: "users-without-wallets"`
 * — T-1601/ADR-0002's scope is embedded wallet login specifically (not
 * "Privy as a login UI in front of an already-owned external wallet"), so
 * a user with no existing linked wallet gets one created automatically as
 * part of login. `PrivyLoginBridge`'s `onComplete` handler does not trust
 * this config alone — it asserts the resulting `user.wallet.walletClientType
 * === "privy"` before treating the address as the login result.
 *
 * Token storage — T-1601's forced verification item (threat model 风险清单
 * row 1, "前端令牌存储与 CSP 核查"): verified against
 * @privy-io/react-auth 3.39.0's own type declaration for
 * `usePrivy().logout` — "the Privy Auth tokens will be deleted from the
 * browser's local storage" — which only makes sense if they were stored
 * there. Per Privy's own "Configure cookies" recipe, the only alternative
 * (httpOnly cookies) requires registering a production custom domain + DNS
 * + a per-domain-locked App ID in the Privy Dashboard — a deployment-level
 * decision this task has no dashboard access to make, and explicitly NOT a
 * `PrivyProvider` prop or any other frontend-code-only switch. **This is
 * the threat model's explicitly-acknowledged, NOT-resolved-by-this-task
 * residual risk**: this project's own code never additionally reads,
 * caches, or persists the access token on top of that (see
 * `PrivyLoginBridge.tsx`'s `PrivyLoginResult` doc comment — it is read
 * fresh per login attempt and used exactly once), but the Privy SDK's own
 * localStorage copy of it is outside this project's control and outside
 * this task's scope to eliminate.
 */
export function PrivyAppProvider({ children }: { children: ReactNode }) {
  const appId = privyAppId();
  if (!appId) {
    return <>{children}</>;
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{ embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } } }}
    >
      <PrivyLoginBridge>{children}</PrivyLoginBridge>
    </PrivyProvider>
  );
}
