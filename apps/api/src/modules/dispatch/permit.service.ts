import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { resolveChainConfig } from "@agent-market/domain";

/**
 * The EIP-712 domain/type definition an `AcceptancePermit` is signed under —
 * copied verbatim from `contracts/src/TaskEscrow.sol`'s
 * `ACCEPTANCE_PERMIT_TYPEHASH` constant and its `EIP712("AgentMarketTaskEscrow",
 * "1")` constructor call (T-706 capsule, itself confirmed against the
 * already-deployed contract). Field name/type/order here must match the
 * contract's typehash string character-for-character, or every signature
 * this module issues would recover a different signer address on-chain and
 * `acceptTask` would reject it with `InvalidPermitSignature` — see
 * `permit.service.typehash.test.ts` for the drift-detection test that
 * guards this.
 */
const ACCEPTANCE_PERMIT_DOMAIN_NAME = "AgentMarketTaskEscrow";
const ACCEPTANCE_PERMIT_DOMAIN_VERSION = "1";

export const ACCEPTANCE_PERMIT_TYPES = {
  AcceptancePermit: [
    { name: "taskId", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

/** One hour, in seconds — the fixed permit lifetime (T-706 capsule: "已与
 * 用户确认，不得偏离"). Not configurable; a shorter/longer window is a
 * product decision Feature 8 would need to re-raise with the user, not a
 * knob this module exposes. */
const PERMIT_LIFETIME_SECONDS = 3600;

/**
 * Loads the platform's `AcceptancePermit` signer from
 * `ACCEPTANCE_PERMIT_SIGNER_KEY`, read at call time (not memoized/read at
 * module load) so a missing key fails loudly the moment a permit is
 * actually requested, matching this codebase's established env-config
 * pattern (`tasks/service.ts`'s `resolveFundingChainConfig`,
 * `chain-config.ts`'s `resolveChainConfig`) rather than a silent
 * pass-at-startup that only surfaces as a confusing failure deep inside
 * `signTypedData` later. The key itself is never included in the thrown
 * error or logged anywhere in this module.
 */
function loadSignerAccount(): ReturnType<typeof privateKeyToAccount> {
  const key = process.env.ACCEPTANCE_PERMIT_SIGNER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "permit.service: ACCEPTANCE_PERMIT_SIGNER_KEY is required and must be a 0x-prefixed 64-hex-char private key",
    );
  }
  return privateKeyToAccount(key as `0x${string}`);
}

/**
 * Generates a fresh high-entropy `uint256` nonce for one permit issuance.
 * Deliberately not persisted or sequence-tracked (T-706 capsule): the
 * contract's `_usedNonces[agent][nonce]` mapping is the sole authority on
 * whether a given nonce has been consumed, so this module's only job is to
 * make collisions between two honestly-issued permits astronomically
 * unlikely, not to enforce uniqueness itself.
 */
function generateNonce(): bigint {
  return BigInt(`0x${randomBytes(32).toString("hex")}`);
}

export interface IssuedAcceptancePermit {
  nonce: bigint;
  expiry: number;
  chainId: number;
  verifyingContract: `0x${string}`;
  signature: `0x${string}`;
}

/**
 * Signs one `AcceptancePermit` authorizing `agentWalletAddress` to call
 * `TaskEscrow.acceptTask` for `taskIdOnChain` (the `bytes32` form of a
 * `tasks.id` UUID — see `onchain-task-id.ts`'s `deriveOnChainTaskId`, which
 * callers must already have applied before calling this function; this
 * module does not do that conversion itself).
 *
 * Uses the account's own `signTypedData` rather than a full
 * `createWalletClient({ transport: http() })` — signing an EIP-712 typed
 * message is a pure local operation (hash + ECDSA sign against the loaded
 * key) that never talks to an RPC node, so wiring up a transport here would
 * be an unused dependency this module doesn't need (T-706 capsule: "不要为了
 * '更完整'引入不必要的 transport/RPC 依赖").
 *
 * `chainId`/`verifyingContract` come from `resolveChainConfig(process.env)`
 * — the same single established reader `tasks/service.ts`'s
 * `resolveFundingChainConfig` already uses — not a second env-var lookup
 * invented here.
 */
export async function issueAcceptancePermit(
  taskIdOnChain: `0x${string}`,
  agentWalletAddress: `0x${string}`,
): Promise<IssuedAcceptancePermit> {
  const account = loadSignerAccount();
  const { chainId, addresses } = resolveChainConfig(process.env);
  const verifyingContract = addresses.taskEscrow;
  const nonce = generateNonce();
  const expiry = Math.floor(Date.now() / 1000) + PERMIT_LIFETIME_SECONDS;

  const signature = await account.signTypedData({
    domain: {
      name: ACCEPTANCE_PERMIT_DOMAIN_NAME,
      version: ACCEPTANCE_PERMIT_DOMAIN_VERSION,
      chainId,
      verifyingContract,
    },
    types: ACCEPTANCE_PERMIT_TYPES,
    primaryType: "AcceptancePermit",
    message: {
      taskId: taskIdOnChain,
      agent: agentWalletAddress,
      nonce,
      expiry: BigInt(expiry),
      chainId: BigInt(chainId),
      verifyingContract,
    },
  });

  return { nonce, expiry, chainId, verifyingContract, signature };
}
