import type { Queryable } from "../../db/pool.js";

/**
 * F-1608/design.md 决策 4 — all three summaries below are pure real-time SQL
 * aggregation over already-verified business data (`tasks`/`chain_events`,
 * themselves populated only from confirmed on-chain events by Feature 6-10's
 * existing funding/acceptance/settlement pipelines) — no new persistent
 * state, no live on-chain RPC call issued by this module itself (用户
 * 2026-09-02 决策：纯数据库聚合，不新增运行时 RPC 依赖). "资金规则只属于合约"
 * (requirements.md 非功能需求) is upheld by construction: this module never
 * invents a balance, it only re-derives one from rows the chain-event
 * ingestion pipeline already wrote after independently verifying them
 * on-chain.
 *
 * Every amount is returned as a decimal STRING (never a JS `number`) —
 * `tasks.budget` is `NUMERIC`, and this codebase's established convention
 * (agents/routes.ts's `referencePrice` handling) is to pass NUMERIC values
 * through untouched rather than risk float precision loss.
 *
 * Status-to-category mapping (one definition, reused identically across
 * all three views below — CLAUDE.md 原则 6, 设计知识只能有一个归属):
 * - "locked"/"当前活跃锁定": `OPEN`/`ACCEPTED`/`SUBMITTED`/`DISPUTED` — every
 *   status after successful funding and before a terminal resolution; the
 *   money is still held in escrow.
 * - "settled"/"已结算": `RELEASED`/`REFUNDED`/`CANCELLED` — every terminal
 *   resolution, money has left escrow to its final destination.
 * - "pendingSettlement"/"待结算": `DISPUTED` alone — a deliberate SUBSET of
 *   "locked" (not a disjoint category): it answers a different question
 *   ("how much of what's locked needs someone's attention right now"),
 *   not "how much money exists that locked doesn't already count."
 * `DRAFT`/`AWAITING_FUNDING` never had real money move and are excluded from
 * every sum (a task that was never funded has no escrowed transfer behind
 * its `budget` column).
 *
 * `CANCELLED` (Codex review, T-1608 round 1 P1 — a genuine correction, not
 * a hypothetical): `contracts/src/TaskEscrow.sol::cancelTask` refunds 100%
 * of `budget` back to the requester and is only callable from `OPEN`
 * (`task.status != OPEN` reverts `TaskNotOpen`) — real money DOES move for
 * a cancelled task, the same direction as `REFUNDED`. The earlier version
 * of this module treated `CANCELLED` as "never funded" because no
 * application code path in `apps/api` currently writes that status (no
 * off-chain listener for `TaskCancelled` exists yet — a pre-existing gap
 * in a different Feature, not introduced here) — but "资金规则只属于合约"
 * means the CONTRACT's behavior is the authority for what counts as money
 * moving, not which off-chain code paths happen to exist today. `CANCELLED`
 * is therefore counted as settled (this function) and as both escrowed and
 * refunded (`getPlatformFundsSummary` below) — never as currently locked,
 * since `cancelTask` requires `OPEN` and cannot apply to an Agent-accepted
 * task (`getAgentFundsSummary`'s own stake/earnedIncome sums are therefore
 * unaffected by `CANCELLED` entirely: no accepted task can ever reach it).
 */

export interface RequesterFundsSummary {
  locked: string;
  settled: string;
  pendingSettlement: string;
}

export async function getRequesterFundsSummary(
  pool: Queryable,
  requesterAddress: string,
): Promise<RequesterFundsSummary> {
  const { rows } = await pool.query<{
    locked: string;
    settled: string;
    pending_settlement: string;
  }>(
    `SELECT
       COALESCE(SUM(budget) FILTER (WHERE status IN ('OPEN', 'ACCEPTED', 'SUBMITTED', 'DISPUTED')), 0) AS locked,
       COALESCE(SUM(budget) FILTER (WHERE status IN ('RELEASED', 'REFUNDED', 'CANCELLED')), 0) AS settled,
       COALESCE(SUM(budget) FILTER (WHERE status = 'DISPUTED'), 0) AS pending_settlement
     FROM tasks
     WHERE requester_address = $1`,
    [requesterAddress],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("getRequesterFundsSummary: aggregate query produced no row");
  }
  return {
    locked: row.locked,
    settled: row.settled,
    pendingSettlement: row.pending_settlement,
  };
}

export interface AgentFundsSummary {
  stake: string;
  earnedIncome: string;
  pendingSettlement: string;
}

/**
 * `stake` reads `chain_events.payload->>'stake'` for this Agent's
 * `TaskAccepted` events (tasks/service.ts's `insertChainEvent` call is the
 * one place that ever writes this field — see its own comment), summed
 * only over tasks still in a non-terminal post-acceptance status
 * (`ACCEPTED`/`SUBMITTED`/`DISPUTED`): once a task reaches `RELEASED` or
 * `REFUNDED`, the contract has already resolved that stake (returned or
 * forfeited per its own rules — not this module's concern to model).
 */
export async function getAgentFundsSummary(
  pool: Queryable,
  agentId: string,
): Promise<AgentFundsSummary> {
  const { rows } = await pool.query<{
    stake: string;
    earned_income: string;
    pending_settlement: string;
  }>(
    `WITH agent_tasks AS (
       SELECT id, budget, status FROM tasks WHERE accepted_agent_id = $1
     )
     SELECT
       COALESCE((
         SELECT SUM((ce.payload ->> 'stake')::numeric)
         FROM chain_events ce
         JOIN agent_tasks at ON at.id = ce.task_id
         WHERE ce.event_name = 'TaskAccepted' AND at.status IN ('ACCEPTED', 'SUBMITTED', 'DISPUTED')
       ), 0) AS stake,
       COALESCE((SELECT SUM(budget) FROM agent_tasks WHERE status = 'RELEASED'), 0) AS earned_income,
       COALESCE((SELECT SUM(budget) FROM agent_tasks WHERE status = 'DISPUTED'), 0) AS pending_settlement`,
    [agentId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("getAgentFundsSummary: aggregate query produced no row");
  }
  return {
    stake: row.stake,
    earnedIncome: row.earned_income,
    pendingSettlement: row.pending_settlement,
  };
}

export interface PlatformFundsSummary {
  totalEscrowed: string;
  totalReleased: string;
  totalRefunded: string;
  activeLocked: string;
}

/**
 * `totalEscrowed`/`activeLocked` additionally include Agent `stake`
 * (Codex review, T-1608 round 2 P2 — a genuine correction): `TaskEscrow.
 * acceptTask` locks an EXTRA `stake` (6% of budget, `STAKE_RATE_BPS`) into
 * the same contract on top of `budget` (`safeTransferFrom(msg.sender,
 * address(this), stake)`), and every terminal payout
 * (`ResultApproved`/`DeliveryTimeoutClaimed`/`ReviewTimeoutFinalized`/
 * `resolveDispute`) moves `budget + stake` together — so a platform total
 * that only sums `budget` systematically undercounts real escrowed funds
 * for every task that ever reached `ACCEPTED`.
 *
 * The stake subquery for `totalEscrowed` needs NO status filter at all:
 * `chain_events.payload->>'stake'` only ever exists on a `TaskAccepted`
 * row (tasks/service.ts's `insertChainEvent` call is the one place that
 * writes it), and a `TaskAccepted` event can only exist for a task that
 * really did reach `ACCEPTED` — by construction, every such row already
 * corresponds to money that entered escrow at some point, with no need to
 * cross-reference the task's CURRENT status. `activeLocked`'s stake
 * subquery DOES need the status filter — matching `getAgentFundsSummary`'s
 * own `stake` query above — since it must reflect what's STILL sitting in
 * escrow right now, not what ever passed through it historically.
 *
 * `totalReleased`/`totalRefunded` deliberately stay budget-only, NOT
 * budget+stake: a `RELEASED` task's stake portion is the accepting Agent's
 * own deposit being returned to them, not compensation "released" to them
 * (same reasoning `getAgentFundsSummary`'s own `earnedIncome` already
 * applies) — and a `REFUNDED`/`CANCELLED` task's stake (when one exists)
 * never goes to the requester either way, so it has no place in a metric
 * named for what the REQUESTER got back.
 */
export async function getPlatformFundsSummary(pool: Queryable): Promise<PlatformFundsSummary> {
  const { rows } = await pool.query<{
    total_escrowed: string;
    total_released: string;
    total_refunded: string;
    active_locked: string;
  }>(
    `SELECT
       COALESCE(SUM(budget) FILTER (
         WHERE status IN ('OPEN', 'ACCEPTED', 'SUBMITTED', 'DISPUTED', 'RELEASED', 'REFUNDED', 'CANCELLED')
       ), 0)
       + COALESCE(
           (SELECT SUM((payload ->> 'stake')::numeric) FROM chain_events WHERE event_name = 'TaskAccepted'),
           0
         ) AS total_escrowed,
       COALESCE(SUM(budget) FILTER (WHERE status = 'RELEASED'), 0) AS total_released,
       COALESCE(SUM(budget) FILTER (WHERE status IN ('REFUNDED', 'CANCELLED')), 0) AS total_refunded,
       COALESCE(SUM(budget) FILTER (WHERE status IN ('OPEN', 'ACCEPTED', 'SUBMITTED', 'DISPUTED')), 0)
       + COALESCE(
           (SELECT SUM((ce.payload ->> 'stake')::numeric)
            FROM chain_events ce
            JOIN tasks t ON t.id = ce.task_id
            WHERE ce.event_name = 'TaskAccepted' AND t.status IN ('ACCEPTED', 'SUBMITTED', 'DISPUTED')),
           0
         ) AS active_locked
     FROM tasks`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("getPlatformFundsSummary: aggregate query produced no row");
  }
  return {
    totalEscrowed: row.total_escrowed,
    totalReleased: row.total_released,
    totalRefunded: row.total_refunded,
    activeLocked: row.active_locked,
  };
}
