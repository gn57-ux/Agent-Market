import type { TaskStatus } from "@agent-market/domain";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetailSections } from "./TaskDetailSections.js";
import * as tasksApi from "./api.js";
import type { TaskRecord } from "./api.js";
import * as recommendationsApi from "../recommendations/api.js";

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: "signed_out",
    address: undefined,
    errorMessage: undefined,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

function taskFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: "0x1234567890123456789012345678901234567890",
    category: "writing",
    title: "A task",
    description: "desc",
    budget: "1000000000000000000",
    token: `0x${"1".repeat(40)}` as const,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: [],
    status: "DRAFT",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Every non-DRAFT/AWAITING_FUNDING/OPEN variant TaskStatus currently has —
// kept as a literal list (not derived from the union) so this test fails
// loudly if a status this suite doesn't know about starts rendering
// something. OPEN has its own dedicated test below (renders
// CandidateSection, T-707).
const NON_FUNDING_STATUSES: TaskStatus[] = [
  { kind: "ACCEPTED", agent: `0x${"2".repeat(40)}` },
  {
    kind: "SUBMITTED",
    agent: `0x${"2".repeat(40)}`,
    submittedAt: "2026-01-01T00:00:00.000Z",
    reviewDeadline: "2026-01-08T00:00:00.000Z",
  },
  { kind: "DISPUTED", agent: `0x${"2".repeat(40)}` },
  { kind: "RELEASED" },
  { kind: "REFUNDED" },
  { kind: "CANCELLED" },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskDetailSections", () => {
  it.each([{ kind: "DRAFT" as const }, { kind: "AWAITING_FUNDING" as const }])(
    "renders FundingSection for status $kind",
    async (status) => {
      vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
      const { findByText } = render(
        <MemoryRouter>
          <TaskDetailSections status={status} taskId="task-1" />
        </MemoryRouter>,
      );
      // FundingSection's own heading — proves the DRAFT/AWAITING_FUNDING
      // branch actually rendered the section, not just returned truthy JSX.
      expect(await findByText("资金锁定")).toBeTruthy();
    },
  );

  it("renders CandidateSection for status OPEN", async () => {
    const getRecommendationsSpy = vi
      .spyOn(recommendationsApi, "getRecommendations")
      .mockResolvedValue({ recommendations: [] });
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "OPEN" }} taskId="task-1" />
      </MemoryRouter>,
    );
    // CandidateSection's own heading — proves the OPEN branch actually
    // rendered the section, not just returned truthy JSX.
    expect(await findByText("推荐候选")).toBeTruthy();
    expect(getRecommendationsSpy).toHaveBeenCalledWith("task-1");
  });

  it.each(NON_FUNDING_STATUSES)(
    "renders nothing (no placeholder content) for status $kind",
    (status) => {
      const getTaskSpy = vi.spyOn(tasksApi, "getTask");
      const { container } = render(
        <MemoryRouter>
          <TaskDetailSections status={status} taskId="task-1" />
        </MemoryRouter>,
      );
      expect(container.innerHTML).toBe("");
      // Confirms these branches return null outright rather than a section
      // that merely renders empty after an async fetch.
      expect(getTaskSpy).not.toHaveBeenCalled();
    },
  );

  // Exhaustiveness itself (a missing case failing to compile) is a
  // TypeScript-level guarantee enforced by `assertExhaustive` in the
  // component's `default` branch — not something expressible as a runtime
  // assertion here. The two `it.each` blocks above already cover every
  // variant `TaskStatus` currently has (DRAFT/AWAITING_FUNDING render
  // FundingSection; the rest render null).
});
