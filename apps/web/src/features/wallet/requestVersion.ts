import { useCallback, useEffect, useRef } from "react";
import { useWallet } from "./WalletProvider.js";

/**
 * Opaque identity token for "which account+network was active when a
 * request started". Two tokens are only ever compared for equality, never
 * ordered or arithmetically combined — so this is a string key derived from
 * (address, chainId), not a numeric counter.
 *
 * Design call (two approaches considered, per project rule requiring a
 * comparison for new shared interfaces):
 *
 * 1. A `useRef` counter bumped by mutating the ref during render whenever
 *    (address, chainId) differs from the previous render's identity.
 *    Rejected: mutating a ref as a side effect of the render function body
 *    is unsound under concurrent React — a render can be started and then
 *    discarded (e.g. superseded by a higher-priority update) without ever
 *    committing, and a ref mutation is not rolled back with it. That would
 *    let the counter drift ahead of what was actually ever displayed,
 *    silently marking still-current requests as stale.
 * 2. Derive the identity as a pure, referentially-meaningless string key
 *    from the already-canonical (address, chainId) pair the WalletProvider
 *    context exposes, and update a ref that mirrors it from a `useEffect`
 *    (which React only runs after a render actually commits). No render-time
 *    side effects; the ref is always in sync with what was actually shown.
 *
 * Chose (2): it stays pure during render (matches React's rules), and needs
 * no ordering semantics — request-staleness only ever asks "is this the same
 * identity as when I started?", which a string key answers just as well as a
 * monotonic integer would, without the correctness risk in (1).
 */
export type RequestVersion = string;

const NO_ADDRESS = "disconnected";
const NO_CHAIN = "unknown";

function currentRequestVersion(
  address: string | undefined,
  chainId: number | undefined,
): RequestVersion {
  return `${address ?? NO_ADDRESS}:${chainId ?? NO_CHAIN}`;
}

/**
 * Returns a value that changes identity exactly when the connected wallet's
 * address or active chain changes. Consumers that need to compare versions
 * themselves (rather than use `useVersionedAsync` below) can depend on this
 * directly, e.g. in a `useEffect` dependency array to re-run a fetch, or by
 * capturing it in a closure and comparing later.
 */
export function useRequestVersion(): RequestVersion {
  const { address, chainId } = useWallet();
  return currentRequestVersion(address, chainId);
}

export interface VersionedAsync<T> {
  /**
   * Runs `fn`, handing it an `isStale()` check the caller may poll during
   * long-running work to bail out early. Regardless of whether `fn` checks
   * `isStale()` itself, the resolved value is only returned if the request's
   * version is still current when `fn` settles — if the wallet's account or
   * network changed while `fn` was in flight, `run` resolves to `undefined`
   * instead, so a stale result can never be applied to state that now
   * represents a different account/network.
   */
  run(fn: (isStale: () => boolean) => Promise<T>): Promise<T | undefined>;
}

/**
 * Shared primitive for the pattern WalletProvider's own `connect()` already
 * uses ad-hoc for its balance read (re-checking `current.address === address
 * && current.chainId === chainId` before applying the result). Feature 5-10
 * consumers that make their own wallet-scoped API calls (fetch a profile,
 * load task history, etc.) should use this instead of reimplementing that
 * check per call site — the staleness rule (never render an in-flight
 * result once the account/network it was requested against is gone) is
 * single-sourced here rather than copied into every feature.
 *
 * API shape (two approaches considered):
 *
 * A. Expose only the raw version value (`useRequestVersion` above) and let
 *    every call site write its own `if (version !== capturedVersion) return;`
 *    guard around the async call. More flexible (works for non-async or
 *    multi-step flows), but every consumer re-derives the same comparison,
 *    which is exactly the duplicated-knowledge pattern the project's rules
 *    on shared modules say to avoid, and it is easy to forget the check
 *    or capture the version at the wrong point (before vs. after an early
 *    await).
 * B. A wrapping helper (`useVersionedAsync`) that owns the "capture version
 *    at start, discard result if it changed by the time the promise
 *    settles" rule itself, so a call site just does
 *    `await run(() => fetchThing(address))` and gets `undefined` back on
 *    staleness without writing the check itself.
 *
 * Chose B as the primary recommended API, while still exporting A
 * (`useRequestVersion`) for call sites with unusual control flow (e.g. an
 * effect that needs to compare versions across multiple awaited steps, or
 * a consumer that wants to skip work entirely rather than discard a
 * result). B is the deep-module default: it makes the common case (call an
 * async function, get back either a fresh result or nothing) a single line,
 * and it cannot be gotten wrong the way a hand-written comparison can.
 */
export function useVersionedAsync<T>(): VersionedAsync<T> {
  const version = useRequestVersion();
  const versionRef = useRef(version);

  // Sync the ref from a commit-phase effect, not during render: see the
  // RequestVersion doc comment above for why a render-time mutation would
  // be unsound under concurrent rendering.
  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  const run = useCallback(
    async (fn: (isStale: () => boolean) => Promise<T>): Promise<T | undefined> => {
      const startVersion = versionRef.current;
      const isStale = () => versionRef.current !== startVersion;
      const result = await fn(isStale);
      return isStale() ? undefined : result;
    },
    [],
  );

  return { run };
}
