import type { Queryable } from "../../db/pool.js";

/**
 * F-2010/T-2008 (用户 2026-09-06 Q-2003 决策): the independent punishment
 * module — the ONLY place that writes `agents.risk_hold_status` or
 * `risk_hold_audit_logs`. Deliberately a SEPARATE top-level module from
 * `antifraud/` (not a file inside it): the user's own instruction is
 * explicit — "检测模块和 admin route 不得直接散写业务表"/"由独立处罚模块
 * 负责". `antifraud/admin-routes.ts`'s `confirm` handler calls `holdAgent`
 * below (orchestration is fine — a route deciding WHEN to call the
 * punishment module is not the same as the route OWNING the punishment
 * write itself), but never executes the `UPDATE agents`/`INSERT INTO
 * risk_hold_audit_logs` statements itself.
 *
 * `risk_hold_status` is DELIBERATELY NOT the same column as `agents.
 * baseline_evaluation_status` (T-2009) — the user's own words: "基础评测
 * 失败"和"风险处罚"是两个正交领域状态"。`baseline_evaluation_status`
 * answers "has this Agent proven baseline competence"; `risk_hold_status`
 * answers "is this Agent currently suspended for a confirmed antifraud
 * signal" — different writers, different trigger conditions, different
 * release mechanisms, and conflating them into one column would make
 * "failed the exam" and "punished for cheating" indistinguishable in the
 * data.
 */

/**
 * Idempotent — always sets `HELD` regardless of the current value (a
 * second CONFIRMED signal for an already-`HELD` Agent is still a real
 * event worth its own audit row, even though the status transition itself
 * is a no-op). `riskSignalId` links this specific HOLD action to the
 * confirmed signal that caused it (nullable at the type level for
 * `releaseAgent`'s own row, never for a real HOLD).
 */
export async function holdAgent(
  client: Queryable,
  input: { agentId: string; riskSignalId: string; actorAddress: string; reason: string },
): Promise<void> {
  await client.query(`UPDATE agents SET risk_hold_status = 'HELD' WHERE id = $1`, [input.agentId]);
  await client.query(
    `INSERT INTO risk_hold_audit_logs (agent_id, risk_signal_id, action, actor_address, reason)
     VALUES ($1, $2, 'HOLD', $3, $4)`,
    [input.agentId, input.riskSignalId, input.actorAddress, input.reason],
  );
}

export interface ReleaseAgentResult {
  /** `false` when the Agent was not actually `HELD` (nothing to release) —
   * the caller (admin-routes.ts) turns this into a 409, matching this
   * codebase's "the mutating statement's own WHERE guard is the source of
   * truth for whether anything really happened" convention (same pattern
   * `resolveRiskSignal`/`resolveAppeal` already establish). */
  ok: boolean;
}

/**
 * The ONLY way `risk_hold_status` ever moves back to `NONE` — user's own
 * explicit requirement: "解除 HOLD 必须通过明确的管理员操作并保留审计记
 * 录，不能靠修改检测记录或重新评测静默清除". Nothing in `antifraud/` or
 * `evaluation/` ever calls this; it exists only behind `POST /admin/
 * agents/:agentId/risk-hold/release` (admin-routes.ts, this module).
 *
 * N4 P1 fix: the caller MUST pass a single already-checked-out client
 * wrapped in its own BEGIN/COMMIT (see admin-routes.ts), not a bare
 * `Pool`. The UPDATE and the audit INSERT below must land on the same
 * connection inside one transaction — passing a `Pool` would let the two
 * statements run on different connections and commit independently: a
 * failed audit insert would leave the Agent silently RELEASED with no
 * required audit record, and a concurrent `holdAgent` could interleave
 * between the two statements, leaving `HELD` status followed by a
 * misleading RELEASE row.
 */
export async function releaseAgent(
  client: Queryable,
  input: { agentId: string; actorAddress: string; reason: string },
): Promise<ReleaseAgentResult> {
  const { rowCount } = await client.query(
    `UPDATE agents SET risk_hold_status = 'NONE' WHERE id = $1 AND risk_hold_status = 'HELD'`,
    [input.agentId],
  );
  if (!rowCount) {
    return { ok: false };
  }
  await client.query(
    `INSERT INTO risk_hold_audit_logs (agent_id, risk_signal_id, action, actor_address, reason)
     VALUES ($1, NULL, 'RELEASE', $2, $3)`,
    [input.agentId, input.actorAddress, input.reason],
  );
  return { ok: true };
}

export interface RiskHoldAuditLogRow {
  id: string;
  agentId: string;
  riskSignalId: string | null;
  action: "HOLD" | "RELEASE";
  actorAddress: string;
  reason: string | null;
  occurredAt: Date;
}

/** Read path for an admin reviewing an Agent's hold history before
 * deciding whether to release it — every HOLD/RELEASE this Agent has ever
 * had, newest first. */
export async function getRiskHoldAuditLog(
  client: Queryable,
  agentId: string,
): Promise<RiskHoldAuditLogRow[]> {
  const { rows } = await client.query<{
    id: string;
    agent_id: string;
    risk_signal_id: string | null;
    action: "HOLD" | "RELEASE";
    actor_address: string;
    reason: string | null;
    occurred_at: Date;
  }>(
    `SELECT id, agent_id, risk_signal_id, action, actor_address, reason, occurred_at
       FROM risk_hold_audit_logs
      WHERE agent_id = $1
      ORDER BY occurred_at DESC`,
    [agentId],
  );
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    riskSignalId: row.risk_signal_id,
    action: row.action,
    actorAddress: row.actor_address,
    reason: row.reason,
    occurredAt: row.occurred_at,
  }));
}
