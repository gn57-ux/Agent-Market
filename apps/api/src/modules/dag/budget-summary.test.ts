import { describe, expect, it } from "vitest";
import { aggregateDagBudget } from "./service.js";

/**
 * Pure unit tests for T-1707's `aggregateDagBudget` — no database, matching
 * topology.ts's own precedent for keeping decision logic independently
 * testable. `totalBudget === releasedBudget + refundedBudget +
 * activeLockedBudget + notYetFundedBudget` is the property under test in
 * every case here — the conservation identity this function's own doc
 * comment says holds by construction.
 */
describe("aggregateDagBudget", () => {
  function assertConserved(summary: ReturnType<typeof aggregateDagBudget>) {
    const sum =
      BigInt(summary.releasedBudget) +
      BigInt(summary.refundedBudget) +
      BigInt(summary.activeLockedBudget) +
      BigInt(summary.notYetFundedBudget);
    expect(sum.toString()).toBe(summary.totalBudget);
  }

  it("buckets a not-yet-activated node (taskStatus/taskBudget both null) as notYetFunded, using subBudget", () => {
    const summary = aggregateDagBudget([{ subBudget: "100", taskStatus: null, taskBudget: null }]);
    expect(summary).toEqual({
      totalBudget: "100",
      releasedBudget: "0",
      refundedBudget: "0",
      activeLockedBudget: "0",
      notYetFundedBudget: "100",
    });
    assertConserved(summary);
  });

  it("buckets DRAFT/AWAITING_FUNDING (activated but not yet on-chain) as notYetFunded, using taskBudget", () => {
    const summary = aggregateDagBudget([
      { subBudget: "50", taskStatus: "DRAFT", taskBudget: "50" },
      { subBudget: "60", taskStatus: "AWAITING_FUNDING", taskBudget: "60" },
    ]);
    expect(summary.notYetFundedBudget).toBe("110");
    expect(summary.totalBudget).toBe("110");
    assertConserved(summary);
  });

  it("buckets OPEN/ACCEPTED/SUBMITTED/DISPUTED as activeLocked", () => {
    const summary = aggregateDagBudget([
      { subBudget: "10", taskStatus: "OPEN", taskBudget: "10" },
      { subBudget: "20", taskStatus: "ACCEPTED", taskBudget: "20" },
      { subBudget: "30", taskStatus: "SUBMITTED", taskBudget: "30" },
      { subBudget: "40", taskStatus: "DISPUTED", taskBudget: "40" },
    ]);
    expect(summary.activeLockedBudget).toBe("100");
    assertConserved(summary);
  });

  it("buckets RELEASED as releasedBudget and REFUNDED/CANCELLED as refundedBudget", () => {
    const summary = aggregateDagBudget([
      { subBudget: "100", taskStatus: "RELEASED", taskBudget: "100" },
      { subBudget: "50", taskStatus: "REFUNDED", taskBudget: "50" },
      { subBudget: "25", taskStatus: "CANCELLED", taskBudget: "25" },
    ]);
    expect(summary.releasedBudget).toBe("100");
    expect(summary.refundedBudget).toBe("75");
    assertConserved(summary);
  });

  it("a mixed real-world DAG conserves total budget across all buckets", () => {
    const summary = aggregateDagBudget([
      { subBudget: "1000", taskStatus: "RELEASED", taskBudget: "1000" },
      { subBudget: "500", taskStatus: "REFUNDED", taskBudget: "500" },
      { subBudget: "300", taskStatus: "OPEN", taskBudget: "300" },
      { subBudget: "200", taskStatus: null, taskBudget: null },
    ]);
    expect(summary.totalBudget).toBe("2000");
    expect(summary.releasedBudget).toBe("1000");
    expect(summary.refundedBudget).toBe("500");
    expect(summary.activeLockedBudget).toBe("300");
    expect(summary.notYetFundedBudget).toBe("200");
    assertConserved(summary);
  });

  it("an empty node list produces all-zero totals", () => {
    const summary = aggregateDagBudget([]);
    expect(summary).toEqual({
      totalBudget: "0",
      releasedBudget: "0",
      refundedBudget: "0",
      activeLockedBudget: "0",
      notYetFundedBudget: "0",
    });
  });

  it("handles budgets large enough that a plain JS number would lose precision", () => {
    const huge = (10n ** 30n).toString();
    const summary = aggregateDagBudget([
      { subBudget: huge, taskStatus: "RELEASED", taskBudget: huge },
    ]);
    expect(summary.totalBudget).toBe(huge);
    expect(summary.releasedBudget).toBe(huge);
  });

  it("N4 real finding (P1): once a task exists, buckets by the task's OWN (possibly edited) budget, not the node's original subBudget", () => {
    // Simulates a real, supported flow: the requester edited the linked
    // DRAFT task's budget via `PATCH /tasks/:taskId/draft` (Feature 6,
    // unmodified) BEFORE funding it, then funded/settled the edited
    // amount. `subBudget` (the node's own immutable declared value) is
    // now stale — the projection must report what was ACTUALLY funded.
    const summary = aggregateDagBudget([
      { subBudget: "100", taskStatus: "RELEASED", taskBudget: "150" },
    ]);
    expect(summary.totalBudget).toBe("150");
    expect(summary.releasedBudget).toBe("150");
    assertConserved(summary);
  });

  it("falls back to subBudget only when taskId/taskBudget is genuinely null (nothing to read yet)", () => {
    const summary = aggregateDagBudget([{ subBudget: "100", taskStatus: null, taskBudget: null }]);
    expect(summary.notYetFundedBudget).toBe("100");
  });
});
