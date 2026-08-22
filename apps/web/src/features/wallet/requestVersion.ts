import { useCallback, useRef } from "react";
import { useWallet } from "./WalletProvider.js";

/**
 * Opaque "which wallet identity generation was active" token. Two tokens are
 * only ever compared for equality by consumers; the actual generation
 * counter is owned and bumped by `WalletProvider` itself (see
 * `WalletContextValue.identityGeneration`'s doc comment for the full
 * rationale — closing both the ABA hazard and the same-tick-batching gap
 * a downstream consumer deriving this from its own render cannot close).
 */
export type RequestVersion = number;

/**
 * Returns a value that changes identity exactly when the connected wallet's
 * address or active chain changes, and never repeats even if the wallet
 * returns to a previously-seen (address, chainId) pair — including when
 * that round trip happens within a single React batch the consumer never
 * individually renders (see `WalletProvider`'s `identityGeneration`).
 */
export function useRequestVersion(): RequestVersion {
  return useWallet().identityGeneration;
}

export interface VersionedAsync<T> {
  /**
   * Runs `fn`, handing it an `isStale()` check the caller may poll during
   * long-running work to bail out early. Regardless of whether `fn` checks
   * `isStale()` itself, the resolved value is only returned if the request's
   * version is still current when `fn` settles — if the wallet's account or
   * network changed while `fn` was in flight (including an A→B→A round
   * trip), `run` resolves to `undefined` instead, so a stale result can
   * never be applied to state that now represents a different account or
   * network, or that already moved on and back.
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
  // Read synchronously during render: `version` reflects
  // `WalletProvider`'s `identityGeneration` as of this render's
  // already-committed context state, which is itself bumped synchronously
  // at the moment of each real transition (not derived from this
  // consumer's own render) — see `useRequestVersion`'s doc comment.
  const version = useRequestVersion();
  const versionRef = useRef(version);
  versionRef.current = version;

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
