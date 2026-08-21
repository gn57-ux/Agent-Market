import { describe, expect, it } from "vitest";
import { assertExhaustive } from "../src/exhaustive.js";
import type { TaskStatus } from "../src/task-status.js";

// Exhaustive switch used purely to prove the compiler enforces coverage:
// if a TaskStatus variant is added without a matching `case` here, `status`
// stops being `never` in the `default` branch and `tsc` fails to compile.
function describeStatus(status: TaskStatus): string {
  switch (status.kind) {
    case "DRAFT":
      return "草稿";
    case "AWAITING_FUNDING":
      return "等待资金确认";
    case "OPEN":
      return "招募中";
    case "ACCEPTED":
      return `已接单：${status.agent}`;
    case "SUBMITTED":
      return `已提交，验收截止 ${status.reviewDeadline}`;
    case "DISPUTED":
      return `争议中：${status.agent}`;
    case "RELEASED":
      return "已放款";
    case "REFUNDED":
      return "已退款";
    case "CANCELLED":
      return "已取消";
    default:
      return assertExhaustive(status, "describeStatus");
  }
}

describe("TaskStatus", () => {
  it("covers every variant (exhaustiveness proven at compile time by describeStatus)", () => {
    const samples: TaskStatus[] = [
      { kind: "DRAFT" },
      { kind: "AWAITING_FUNDING" },
      { kind: "OPEN" },
      { kind: "ACCEPTED", agent: "0xabc" },
      {
        kind: "SUBMITTED",
        agent: "0xabc",
        submittedAt: "2026-08-21T00:00:00Z",
        reviewDeadline: "2026-08-24T00:00:00Z",
      },
      { kind: "DISPUTED", agent: "0xabc" },
      { kind: "RELEASED" },
      { kind: "REFUNDED" },
      { kind: "CANCELLED" },
    ];

    for (const sample of samples) {
      expect(() => describeStatus(sample)).not.toThrow();
    }
    expect(samples).toHaveLength(9);
  });
});
