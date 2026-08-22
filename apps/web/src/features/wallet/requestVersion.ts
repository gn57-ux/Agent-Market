import { useCallback, useRef } from "react";
import { useWallet } from "./WalletProvider.js";

/**
 * Opaque "which wallet identity generation was active" token. Two tokens are
 * only ever compared for equality by consumers, but internally this is a
 * monotonically increasing generation counter, NOT a value derived solely
 * from the current (address, chainId) pair — see the ABA note below for why
 * that distinction matters.
 */
export type RequestVersion = number;

const NO_ADDRESS = "disconnected";
const NO_CHAIN = "unknown";

function walletIdentityKey(address: string | undefined, chainId: number | undefined): string {
  return `${address ?? NO_ADDRESS}:${chainId ?? NO_CHAIN}`;
}

interface VersionState {
  identityKey: string;
  generation: RequestVersion;
}

/**
 * Returns a value that changes identity exactly when the connected wallet's
 * address or active chain changes, and never repeats even if the wallet
 * returns to a previously-seen (address, chainId) pair.
 *
 * Design call (two approaches considered, per project rule requiring a
 * comparison for new shared interfaces):
 *
 * 1. A pure string key derived from `${address}:${chainId}` — two identical
 *    pairs always compare equal. REJECTED after Codex review round 1
 *    surfaced an ABA hazard: a request starts on (A, X), the wallet switches
 *    to (B, Y) and back to (A, X) before the request settles, and the key
 *    equals its start value again — `useVersionedAsync` would then treat an
 *    objectively stale result (issued against an intervening, different
 *    identity) as fresh. Acceptable for a single hand-rolled call site that
 *    can reason about its own request shape, but this is a *shared*
 *    primitive future Feature 5-10 consumers won't have that context for,
 *    so silently reintroducing an ABA bug for them is not acceptable.
 * 2. A monotonically increasing generation counter, bumped every time the
 *    identity key changes (never reused, never revisited). Chosen: this
 *    closes the ABA case structurally — going A→B→A produces generations
 *    0→1→2, so a request started at generation 0 is correctly still
 *    considered stale even after the wallet returns to address A.
 *
 * Synchronous-update note (also from Codex review round 1): the previous
 * implementation synced a ref from a `useEffect`, which only flushes *after*
 * commit — a promise already resolved and queued on the microtask queue can
 * run before a deferred passive effect, so a request settling in that window
 * would read the pre-switch version and incorrectly pass the staleness
 * check. Fixed by mutating the ref synchronously in the render body instead.
 * That is safe here specifically because `identityKey`/`generation` are
 * derived only from `address`/`chainId`, which is itself already-committed
 * WalletProvider context state for any given render (React always reads the
 * latest committed state during render, even a later-discarded/speculative
 * one) — so even a discarded render just recomputes the same generation a
 * subsequent real render would, with no drift. This differs from mutating a
 * ref that held independent, order-dependent history during render, which
 * would be unsound under concurrent rendering.
 */
export function useRequestVersion(): RequestVersion {
  const { address, chainId } = useWallet();
  const identityKey = walletIdentityKey(address, chainId);
  const stateRef = useRef<VersionState>({ identityKey, generation: 0 });

  if (stateRef.current.identityKey !== identityKey) {
    stateRef.current = { identityKey, generation: stateRef.current.generation + 1 };
  }

  return stateRef.current.generation;
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
  // Read synchronously during render (see useRequestVersion's doc comment
  // for why this is safe): `version` always reflects the wallet identity
  // generation as of this render's already-committed context state.
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
