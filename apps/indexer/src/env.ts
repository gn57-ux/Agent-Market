/**
 * `main.ts`'s own env-resolution helpers, pulled into their own module
 * (T-1806 round 2) so they can be unit-tested directly — `main.ts` itself
 * calls `main()` unconditionally at module load (it is a process entry
 * point, not a library), so importing it from a test would start a real
 * indexer loop against a real DB connection. These functions have no such
 * side effect: each just turns one raw env var into its real typed value,
 * or throws/validates.
 */

/**
 * Q-1803 (requirements.md's own "开放问题") explicitly leaves the real
 * confirmation-depth number undecided pending the target network's actual
 * block/reorg characteristics — this default is a clearly-labeled
 * placeholder (roughly Ethereum mainnet's own common "safe" convention),
 * not a researched-and-confirmed value for any specific deployment target.
 * An operator MUST set `INDEXER_CONFIRMATION_DEPTH` explicitly for a real
 * deployment once Q-1803 is actually answered.
 */
export const DEFAULT_CONFIRMATION_DEPTH = 12n;

export function resolveContractAddress(env: NodeJS.ProcessEnv): `0x${string}` {
  const address = env.TASK_ESCROW_ADDRESS;
  if (!address) {
    throw new Error("TASK_ESCROW_ADDRESS is not set — apps/indexer needs it to scan logs.");
  }
  return address as `0x${string}`;
}

export function resolveChainId(env: NodeJS.ProcessEnv): number {
  const chainId = env.CHAIN_ID;
  if (!chainId) {
    throw new Error("CHAIN_ID is not set — apps/indexer needs it to tag indexed events.");
  }
  return Number(chainId);
}

/**
 * T-1806 round 2 (N4 real P2 fix): a negative depth makes
 * `confirmIndexedEvents`'s own `latestBlock - confirmationDepth`
 * arithmetic land ABOVE the current tip, so every `PENDING_CONFIRMATION`
 * row would be promoted immediately regardless of how many real
 * confirmations it has — silently defeating the entire reorg-safety
 * purpose this value exists for. Validated once, here, at the single
 * place that turns the raw env var into the real typed value every
 * caller trusts (CLAUDE.md 原则 7/8) — `confirmIndexedEvents` itself stays
 * a generic mechanism that doesn't re-validate its caller's input.
 */
export function resolveConfirmationDepth(env: NodeJS.ProcessEnv): bigint {
  if (!env.INDEXER_CONFIRMATION_DEPTH) return DEFAULT_CONFIRMATION_DEPTH;
  const parsed = BigInt(env.INDEXER_CONFIRMATION_DEPTH);
  if (parsed < 0n) {
    throw new Error(
      `INDEXER_CONFIRMATION_DEPTH must be a non-negative integer, got ` +
        `"${env.INDEXER_CONFIRMATION_DEPTH}".`,
    );
  }
  return parsed;
}
