import { keccak256, toBytes } from "viem";

/**
 * `keccak256("ARBITRATOR_ROLE")` — computed the same way Solidity computes
 * it (`bytes32 public constant ARBITRATOR_ROLE =
 * keccak256("ARBITRATOR_ROLE")`, contracts/src/TaskEscrow.sol): keccak256
 * over the UTF-8 bytes of the literal, not an ABI-encoded string. Computed
 * here rather than hardcoded so a typo in a copy-pasted hex literal can
 * never silently diverge from the contract's own constant.
 */
export const ARBITRATOR_ROLE = keccak256(toBytes("ARBITRATOR_ROLE"));

export type DisputeAccessLevel = "full" | "public";

export interface ResolveDisputeAccessLevelParams {
  /** The caller's wallet address, from a verified session — `null` for an
   * anonymous request or an invalid/expired session (never a self-reported
   * value from the request body/query). */
  sessionAddress: string | null;
  requesterAddress: string;
  acceptedAgentAddress: string | null;
  /**
   * Reads `TaskEscrow.hasRole(ARBITRATOR_ROLE, account)` on-chain — a
   * callback rather than an already-constructed `ChainRpcClient` +
   * contract address, so this module never forces its caller to resolve
   * chain config or open an RPC client on every call. That matters: most
   * viewers (anonymous, the requester, the accepted Agent) are decided
   * below WITHOUT ever needing this callback, and `resolveChainConfig`/
   * `createChainRpcClient` both throw immediately if their required env
   * vars aren't set — eagerly constructing them for every `GET
   * /tasks/:taskId/disputes` request would turn a route meant to stay
   * public into one that 500s whenever chain config is absent, even for
   * viewers who were never going to need it.
   *
   * If this throws (RPC unreachable, chain config missing/invalid, or any
   * other failure), `resolveDisputeAccessLevel` fails CLOSED to "public" —
   * see its own doc comment (T-1002 human-review fix, round 2 of this
   * fix, P2: an unproven on-chain claim must never 500 a route this
   * endpoint's own design keeps public, and must never be treated as
   * proof of the arbitrator role either).
   */
  isArbitrator: (account: string) => Promise<boolean>;
  /**
   * Called (never thrown) when `isArbitrator` itself throws, so a caller
   * can log/alert on "the on-chain check couldn't complete" without that
   * failure ever reaching the HTTP response — the response only ever
   * carries the resulting access LEVEL ("public"), never the underlying
   * RPC/config error. Optional: a caller that doesn't need observability
   * here can omit it and the failure is silently (but safely) absorbed.
   */
  onArbitratorCheckError?: (error: unknown) => void;
}

/**
 * The single place this codebase decides who may see a dispute's full,
 * private detail (`evidenceSummary`) versus only its public metadata
 * (T-1002 human-review fix, Codex round 2 P1: `GET
 * /tasks/:taskId/disputes` previously returned `evidenceSummary` to any
 * anonymous or unrelated caller, since task IDs are discoverable via the
 * public tasks list).
 *
 * "Full" access is granted to exactly three parties, matching this
 * dispute's own real participants:
 * - the task's requester (who filed it);
 * - the task's accepted Agent (who it's filed against);
 * - whoever currently holds `TaskEscrow.ARBITRATOR_ROLE` on-chain.
 *
 * The requester/agent checks are a cheap address comparison against
 * `sessionAddress` — itself only ever populated from a verified session,
 * never a self-reported identity, and NEVER go through `isArbitrator` (no
 * RPC/chain dependency for these two paths, by construction). The
 * arbitrator check is NOT a self-reported claim either: `isArbitrator`
 * reads `hasRole` directly from the deployed contract, the same authority
 * `resolveDispute` itself defers to (design.md: "链上 ARBITRATOR_ROLE 是
 * 唯一权威校验"). This function is the ONLY caller of that check for this
 * purpose — no route re-derives or duplicates the participant/arbitrator
 * check itself.
 *
 * Fails CLOSED: if `isArbitrator` throws (RPC unreachable, chain config
 * missing/invalid, or any other failure), that is treated as "role not
 * proven" — the caller falls through to "public", the SAME outcome as an
 * explicit `false`. An on-chain claim that cannot be verified is never
 * granted "full" access, and its failure never propagates up to 500 the
 * whole (otherwise-public) request — the endpoint's own design is
 * "public minimal projection always available, private detail only once
 * proven", not "private detail, or an error".
 */
export async function resolveDisputeAccessLevel(
  params: ResolveDisputeAccessLevelParams,
): Promise<DisputeAccessLevel> {
  const {
    sessionAddress,
    requesterAddress,
    acceptedAgentAddress,
    isArbitrator,
    onArbitratorCheckError,
  } = params;
  if (!sessionAddress) {
    return "public";
  }
  const normalizedSession = sessionAddress.toLowerCase();
  if (normalizedSession === requesterAddress.toLowerCase()) {
    return "full";
  }
  if (acceptedAgentAddress && normalizedSession === acceptedAgentAddress.toLowerCase()) {
    return "full";
  }
  try {
    return (await isArbitrator(sessionAddress)) ? "full" : "public";
  } catch (error) {
    onArbitratorCheckError?.(error);
    return "public";
  }
}
