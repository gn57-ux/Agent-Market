import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../../db/pool.js";
import { applySettlementStats, type SettlementEventKind } from "./settlement-stats.js";

function buildFakePool(): { pool: Queryable; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { pool: { query } as unknown as Queryable, query };
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("applySettlementStats", () => {
  const cases: Array<{ kind: SettlementEventKind; successDelta: number; overdueDelta: number }> = [
    { kind: "RESULT_APPROVED", successDelta: 1, overdueDelta: 0 },
    { kind: "REVIEW_TIMEOUT_FINALIZED", successDelta: 1, overdueDelta: 0 },
    { kind: "DISPUTE_RESOLVED_SUPPORT_AGENT", successDelta: 1, overdueDelta: 0 },
    { kind: "DELIVERY_TIMEOUT_CLAIMED", successDelta: 0, overdueDelta: 1 },
    { kind: "DISPUTE_RESOLVED_SUPPORT_REQUESTER", successDelta: 0, overdueDelta: 0 },
  ];

  it.each(cases)(
    "increments completedTaskCount by 1 always, and success/overdue per $kind's own mapping",
    async ({ kind, successDelta, overdueDelta }) => {
      const { pool, query } = buildFakePool();
      await applySettlementStats(pool, AGENT_ID, kind);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("completed_task_count = completed_task_count + 1");
      expect(sql).toContain("WHERE id = $1");
      expect(params).toEqual([AGENT_ID, successDelta, overdueDelta]);
    },
  );

  // AC-1008 (this module's half): never touches quality_score — a
  // regression here would silently let this module start writing a field
  // ratings/service.ts is supposed to exclusively own.
  it("never references quality_score in its SQL", async () => {
    const { pool, query } = buildFakePool();
    await applySettlementStats(pool, AGENT_ID, "RESULT_APPROVED");
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("quality_score");
  });

  // AC-1005: a delivery timeout must never also count as a success, and a
  // dispute lost by the agent must never count as either a success or an
  // overdue delivery.
  it("DELIVERY_TIMEOUT_CLAIMED never increments successCount", async () => {
    const { pool, query } = buildFakePool();
    await applySettlementStats(pool, AGENT_ID, "DELIVERY_TIMEOUT_CLAIMED");
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe(0);
  });

  it("DISPUTE_RESOLVED_SUPPORT_REQUESTER never increments overdueCount (a dispute is not a delivery timeout)", async () => {
    const { pool, query } = buildFakePool();
    await applySettlementStats(pool, AGENT_ID, "DISPUTE_RESOLVED_SUPPORT_REQUESTER");
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe(0);
  });
});
