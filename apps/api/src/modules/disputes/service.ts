import { resolveChainConfig } from "@agent-market/domain";
import type { Pool } from "pg";
import { normalizeAddress } from "../auth/nonce.store.js";
import type { ChainRpcClient } from "../chain/rpc.client.js";
import { getTaskById } from "../tasks/repository.js";
import { ARBITRATOR_ROLE, resolveDisputeAccessLevel } from "./access-guard.js";
import { getDisputeForTask, type DisputeRow } from "./repository.js";

export interface DisputeViewResponse {
  disputeId: string;
  status: DisputeRow["status"];
  reason: string;
  resolution: DisputeRow["resolution"];
  resolvedAt: string | null;
  /** Present only when `access-guard.ts`'s `resolveDisputeAccessLevel`
   * grants "full" access — absent (not `null`, not an empty string) for
   * every other viewer, so a client can distinguish "you're not allowed to
   * see this" from "there's nothing here" (T-1002 human-review fix,
   * Codex round 2 P1). */
  evidenceSummary?: string;
  evidenceHash?: `0x${string}`;
}

export type GetDisputeViewResult =
  | { ok: true; view: DisputeViewResponse }
  | { ok: false; reason: "task_not_found" }
  | { ok: false; reason: "dispute_not_found" };

/**
 * `GET /tasks/:taskId/disputes`'s ENTIRE data-fetching and access-decision
 * logic, pulled out of `disputes/routes.ts` into its own directly callable
 * function — the same "chain-touching logic lives in a plain
 * pool+rpc-parameterized function, the route just wires it to HTTP"
 * pattern `tasks/service.ts`'s `verifyDisputeOpen`/`verifyDisputeResolution`
 * already establish. This is what makes the on-chain-arbitrator path
 * (`access-guard.ts`'s `isArbitrator` callback, backed by `readHasRole`)
 * testable with a fake `ChainRpcClient` directly, without needing a real
 * chain at the full-HTTP layer (T-1002 human-review fix, Codex round 2
 * P1).
 *
 * `getRpc` is a FACTORY, not an already-constructed `ChainRpcClient` — it
 * is only invoked (alongside `resolveChainConfig`, itself deferred the
 * same way) from inside `access-guard.ts`'s `isArbitrator` callback, which
 * `resolveDisputeAccessLevel` only calls once anonymous/requester/agent
 * viewers are already ruled out. Both `resolveChainConfig` and
 * `createChainRpcClient` throw immediately if their required env vars
 * aren't set — constructing either eagerly for every request would turn
 * this public route into one that 500s for viewers (the large majority)
 * who never needed on-chain state at all.
 *
 * `onArbitratorCheckError`, if provided, is called (never thrown) whenever
 * the on-chain role check itself fails (RPC unreachable, chain config
 * missing/invalid) — for logging/observability only. `access-guard.ts`'s
 * `resolveDisputeAccessLevel` already fails CLOSED to "public" in that
 * case (T-1002 human-review fix round 2, P2: an RPC/config failure must
 * never 500 this public route, and must never be treated as proof of the
 * arbitrator role either) — this callback never influences that outcome,
 * it only observes it.
 */
export async function getDisputeView(
  pool: Pool,
  getRpc: () => ChainRpcClient,
  sessionAddress: string | null,
  taskId: string,
  onArbitratorCheckError?: (error: unknown) => void,
): Promise<GetDisputeViewResult> {
  const task = await getTaskById(pool, taskId);
  if (!task) {
    return { ok: false, reason: "task_not_found" };
  }

  const dispute = await getDisputeForTask(pool, task.id);
  if (!dispute) {
    return { ok: false, reason: "dispute_not_found" };
  }

  const publicProjection: DisputeViewResponse = {
    disputeId: dispute.id,
    status: dispute.status,
    reason: dispute.reason,
    resolution: dispute.resolution,
    resolvedAt: dispute.resolvedAt ? dispute.resolvedAt.toISOString() : null,
  };

  const accessLevel = await resolveDisputeAccessLevel({
    sessionAddress,
    requesterAddress: task.requesterAddress,
    acceptedAgentAddress: task.acceptedAgentAddress,
    isArbitrator: async (account) => {
      // Explicit format validation + normalization at the RPC boundary
      // (T-1002 human-review fix round 2, P2) — `normalizeAddress` is the
      // same checked-format function every other address value in this
      // codebase passes through before use (auth/nonce.store.ts), so this
      // is never a blind reinterpretation of `sessionAddress`'s string
      // type as a hex address; `readHasRole`'s `` `0x${string}` `` param
      // is satisfied by a value that has actually been regex-validated
      // immediately beforehand. A malformed address throws
      // `InvalidAddressError`, which `resolveDisputeAccessLevel`'s own
      // try/catch around this whole callback already treats as "role not
      // proven" (fail-closed to public), same as any other failure here.
      const normalizedAccount = normalizeAddress(account) as `0x${string}`;
      const chainConfig = resolveChainConfig(process.env);
      return getRpc().readHasRole(
        chainConfig.addresses.taskEscrow,
        ARBITRATOR_ROLE,
        normalizedAccount,
      );
    },
    onArbitratorCheckError,
  });

  if (accessLevel !== "full") {
    return { ok: true, view: publicProjection };
  }

  return {
    ok: true,
    view: {
      ...publicProjection,
      evidenceSummary: dispute.evidenceSummary,
      evidenceHash: dispute.evidenceHash,
    },
  };
}
