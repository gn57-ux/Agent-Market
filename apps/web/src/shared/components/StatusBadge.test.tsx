import type { TaskStatus } from "@agent-market/domain";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge.js";

const AGENT = "0xabc" as const;

// Exhaustive: one sample per TaskStatus variant (all 9), matching
// packages/domain's TaskStatus union exactly.
const SAMPLES: Array<{ status: TaskStatus; expectedText: string }> = [
  { status: { kind: "DRAFT" }, expectedText: "草稿" },
  { status: { kind: "AWAITING_FUNDING" }, expectedText: "等待资金确认" },
  { status: { kind: "OPEN" }, expectedText: "招募中" },
  { status: { kind: "ACCEPTED", agent: AGENT }, expectedText: "已接单" },
  {
    status: {
      kind: "SUBMITTED",
      agent: AGENT,
      submittedAt: "2026-08-21T00:00:00Z",
      reviewDeadline: "2026-08-24T00:00:00Z",
    },
    expectedText: "待验收",
  },
  { status: { kind: "DISPUTED", agent: AGENT }, expectedText: "争议中" },
  { status: { kind: "RELEASED" }, expectedText: "已放款" },
  { status: { kind: "REFUNDED" }, expectedText: "已退款" },
  { status: { kind: "CANCELLED" }, expectedText: "已取消" },
];

describe("StatusBadge", () => {
  it.each(SAMPLES)("renders $status.kind as $expectedText", ({ status, expectedText }) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(expectedText)).toBeTruthy();
  });

  it("covers every TaskStatus variant (exhaustiveness sanity check)", () => {
    expect(SAMPLES).toHaveLength(9);
  });
});
