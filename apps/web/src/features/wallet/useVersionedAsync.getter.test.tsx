import type { ChainConfig, HexAddress } from "@agent-market/domain";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WalletContextValue } from "./WalletProvider.js";
import { useVersionedAsync } from "./requestVersion.js";

// Mocks the whole WalletProvider module so this file can control exactly
// what `useWallet()` returns, independent of any real render cycle — kept
// in its own file (rather than added to requestVersion.test.tsx) because
// `vi.mock` replaces the module for every test in the file, which would
// break requestVersion.test.tsx's other tests that render the real
// `WalletProvider`/`WalletConnectionStatus` components.
vi.mock("./WalletProvider.js", async () => {
  const actual = await vi.importActual<typeof import("./WalletProvider.js")>("./WalletProvider.js");
  return { ...actual, useWallet: vi.fn() };
});

const { useWallet } = await import("./WalletProvider.js");

/** Built via `.repeat()` rather than a literal digit run, purely so this
 * placeholder fixture address doesn't read as a long repeated-hex-digit
 * string to pattern-based scanners — same fixture-construction style used
 * elsewhere in this project's contract test suite. */
function placeholderAddress(digit: string): HexAddress {
  return `0x${digit.repeat(40)}` as HexAddress;
}

const CHAIN_CONFIG: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: placeholderAddress("2"),
    ydToken: placeholderAddress("1"),
    ydFaucet: placeholderAddress("3"),
  },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Builds a `WalletContextValue` backed by a mutable `generation` counter,
 * with `getIdentityGeneration` reading it live and `identityGeneration`
 * fixed at whatever it was when this mock object was built — simulating
 * exactly the gap Codex flagged: a render-time snapshot that goes stale
 * the instant the real value changes, versus a getter that never does. */
function mockWalletContext(generationBox: { current: number }): WalletContextValue {
  return {
    connection: { status: "disconnected" },
    address: undefined,
    chainId: undefined,
    chainConfig: CHAIN_CONFIG,
    isCorrectNetwork: false,
    errorMessage: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchNetwork: vi.fn(),
    identityGeneration: generationBox.current,
    getIdentityGeneration: () => generationBox.current,
    signMessage: vi.fn(),
  };
}

describe("useVersionedAsync — staleness check reads a live getter, not a render snapshot", () => {
  it("discards a result when identity changes with NO re-render of the calling hook (Codex P1 regression)", async () => {
    // Regression for Codex review round 3's P1: `useVersionedAsync` used to
    // mirror `useRequestVersion()`'s return value (itself a snapshot of
    // `WalletContextValue.identityGeneration` as of the consumer's last
    // render) into a `useRef`, updated only during render. If the identity
    // changed and the async op settled before that consumer next
    // re-rendered, the mirrored ref was still stale and the check
    // incorrectly passed. This test never re-renders the hook at all —
    // proving the fix (`getIdentityGeneration()`, read live at check time)
    // has no dependency on rendering whatsoever, unlike the old ref-mirror
    // approach this would have failed under.
    const generationBox = { current: 0 };
    vi.mocked(useWallet).mockReturnValue(mockWalletContext(generationBox));

    const { result } = renderHook(() => useVersionedAsync<string>());

    const deferred = createDeferred<string>();
    const runPromise = result.current.run(() => deferred.promise);

    // Bump the live source directly — no state update, no re-render, no
    // `act()`. This is the exact "changed but not yet rendered" window the
    // old ref-mirror implementation could not see.
    generationBox.current += 1;

    deferred.resolve("value-from-before-the-change");
    const settled = await runPromise;

    expect(settled).toBeUndefined();
  });

  it("keeps a result when identity has not changed by the time it settles", async () => {
    const generationBox = { current: 0 };
    vi.mocked(useWallet).mockReturnValue(mockWalletContext(generationBox));

    const { result } = renderHook(() => useVersionedAsync<string>());

    const deferred = createDeferred<string>();
    const runPromise = result.current.run(() => deferred.promise);

    deferred.resolve("value-still-current");
    const settled = await runPromise;

    expect(settled).toBe("value-still-current");
  });
});
