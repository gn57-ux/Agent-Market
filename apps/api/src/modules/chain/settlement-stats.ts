import type { Queryable } from "../../db/pool.js";

/**
 * F-1006's other half of the field-ownership split (design.md's 技术决策
 * table, 方案 B): this module owns EXACTLY `agents.completed_task_count`/
 * `success_count`/`overdue_count` and nothing else — never
 * `quality_score`, which is `ratings/service.ts`'s exclusive concern. The
 * two modules share no mutable state and are never called from each
 * other, by design (no "which one processes this" ambiguity).
 *
 * Every kind of terminal settlement this Feature's contract functions can
 * produce, mapped to exactly what this module counts:
 *   - `RESULT_APPROVED` (`approveResult`, requester-triggered): completed+1, success+1.
 *   - `REVIEW_TIMEOUT_FINALIZED` (`finalizeReviewTimeout`, anyone-triggered
 *     once the requester never acted): completed+1, success+1 — the same
 *     payout as approval, just a different trigger (F-1002).
 *   - `DELIVERY_TIMEOUT_CLAIMED` (`claimDeliveryTimeout`, agent never
 *     delivered): completed+1, overdue+1 — the ONLY event that increments
 *     `overdueCount` (a dispute-driven refund is a quality outcome, not a
 *     delivery-timeout outcome, and must never be counted as one).
 *   - `DISPUTE_RESOLVED_SUPPORT_AGENT`/`DISPUTE_RESOLVED_SUPPORT_REQUESTER`
 *     (`resolveDispute`, arbitrator-triggered): completed+1 always;
 *     success+1 only when the arbitrator sided with the agent. Never
 *     overdue+1 — a dispute is not a delivery timeout.
 */
export type SettlementEventKind =
  | "RESULT_APPROVED"
  | "DELIVERY_TIMEOUT_CLAIMED"
  | "REVIEW_TIMEOUT_FINALIZED"
  | "DISPUTE_RESOLVED_SUPPORT_AGENT"
  | "DISPUTE_RESOLVED_SUPPORT_REQUESTER";

interface SettlementCountDelta {
  successDelta: 0 | 1;
  overdueDelta: 0 | 1;
}

/**
 * T-2305 (F-2307 "结算成功率"): exported so callers can label the
 * `settlement_outcome_total` metric AFTER their surrounding DB transaction
 * actually commits (see `applySettlementStats`'s own doc comment on why
 * the metric increment must not happen from inside this module, which runs
 * INSIDE that transaction and could still be rolled back by a later step)
 * — without duplicating this mapping a second time at each call site.
 */
export function deltaFor(kind: SettlementEventKind): SettlementCountDelta {
  switch (kind) {
    case "RESULT_APPROVED":
    case "REVIEW_TIMEOUT_FINALIZED":
    case "DISPUTE_RESOLVED_SUPPORT_AGENT":
      return { successDelta: 1, overdueDelta: 0 };
    case "DELIVERY_TIMEOUT_CLAIMED":
      return { successDelta: 0, overdueDelta: 1 };
    case "DISPUTE_RESOLVED_SUPPORT_REQUESTER":
      return { successDelta: 0, overdueDelta: 0 };
  }
}

/**
 * Applies exactly one terminal settlement outcome to `agentId`'s
 * `completed_task_count`/`success_count`/`overdue_count` — `completed_task_count`
 * always +1 (every kind here is a real terminal settlement), the other two
 * per `deltaFor`'s mapping above.
 *
 * Keyed by `agentId` (`agents.id`, the same UUID `tasks.accepted_agent_id`
 * stores), NOT the agent's wallet address — a single wallet can own
 * multiple `Agent` records (`AcceptanceSection.tsx`'s own T-807 fix
 * documents this exact scenario), so crediting a wallet address would
 * attribute a settlement to the wrong Agent whenever its owner has more
 * than one. `tasks.accepted_agent_id` already disambiguates which
 * specific Agent record accepted this task (0006_add_dispatch_matching_fields.sql),
 * so callers pass that value straight through, not `accepted_agent_address`.
 *
 * Idempotency is NOT this function's concern: it performs one real
 * increment per call, unconditionally. The caller (event-sync's
 * settlement-event consumption, `tasks/service.ts`) is responsible for
 * ensuring this is only ever called once per real on-chain event — the
 * same `(chainId, blockHash, transactionHash, logIndex)` uniqueness this
 * codebase already established (`chain_events`/`chain_transactions`,
 * Feature 6/8/9) is what provides that guarantee, by construction, since
 * this function is only ever invoked from inside the same transaction that
 * inserts those rows for the first time.
 *
 * Takes a `Queryable` (not `Pool`) specifically so it can run INSIDE the
 * same DB transaction as the `tasks` status UPDATE that triggered it
 * (`transitionTaskStatus`'s `withinTransaction` callback) — the settlement
 * projection and this count update must commit together or not at all.
 */
export async function applySettlementStats(
  pool: Queryable,
  agentId: string,
  kind: SettlementEventKind,
): Promise<void> {
  const { successDelta, overdueDelta } = deltaFor(kind);
  await pool.query(
    `UPDATE agents
     SET completed_task_count = completed_task_count + 1,
         success_count = success_count + $2,
         overdue_count = overdue_count + $3
     WHERE id = $1`,
    [agentId, successDelta, overdueDelta],
  );
}
