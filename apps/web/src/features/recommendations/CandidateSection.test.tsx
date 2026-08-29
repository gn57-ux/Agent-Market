import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateSection } from "./CandidateSection.js";
import * as recommendationsApi from "./api.js";
import * as tasksApi from "../tasks/api.js";
import type { RecommendationCandidate } from "./api.js";

const REQUESTER = "0x1111111111111111111111111111111111111111";
let mockSession: { status: "signed_in" | "signed_out"; address?: string } = {
  status: "signed_out",
};

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => mockSession,
}));

function candidateFixture(
  overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
  return {
    agentId: "11111111-2222-3333-4444-555555555555",
    rank: 1,
    slotType: "TOP_SCORE",
    score: 0.87,
    reasons: ["技能匹配", "历史完成率高"],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mockSession = { status: "signed_out" };
});

describe("CandidateSection", () => {
  it("fetches recommendations given only a taskId", async () => {
    const spy = vi
      .spyOn(recommendationsApi, "getRecommendations")
      .mockResolvedValue({ recommendations: [] });
    render(<CandidateSection taskId="task-1" />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("task-1"));
  });

  it("starts matching before reading recommendations when the signed-in viewer owns the task", async () => {
    mockSession = { status: "signed_in", address: REQUESTER };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue({
      taskId: "task-1",
      requesterAddress: REQUESTER,
    } as Awaited<ReturnType<typeof tasksApi.getTask>>);
    const match = vi.spyOn(recommendationsApi, "requestMatch").mockResolvedValue({
      taskId: "task-1",
      algorithmVersion: "v0.1",
      recommendationCount: 1,
    });
    const get = vi
      .spyOn(recommendationsApi, "getRecommendations")
      .mockResolvedValue({ recommendations: [candidateFixture()] });

    render(<CandidateSection taskId="task-1" />);

    expect(await screen.findByText("高分候选")).toBeTruthy();
    expect(match).toHaveBeenCalledWith("task-1");
    expect(match.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0] ?? 0);
  });

  it("shows the empty state (AC-706) instead of a placeholder Agent when there are no candidates", async () => {
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({ recommendations: [] });
    render(<CandidateSection taskId="task-1" />);

    expect(await screen.findByText("暂无合适 Agent")).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("renders a TOP_SCORE candidate with its rank, score, and reasons", async () => {
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [candidateFixture({ slotType: "TOP_SCORE", rank: 1, score: 0.87 })],
    });
    render(<CandidateSection taskId="task-1" />);

    expect(await screen.findByText("高分候选")).toBeTruthy();
    expect(screen.getByText(/评分 0\.87/)).toBeTruthy();
    expect(screen.getByText("技能匹配")).toBeTruthy();
    expect(screen.getByText("历史完成率高")).toBeTruthy();
  });

  it("visually distinguishes an EXPLORATION candidate from TOP_SCORE candidates", async () => {
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [
        candidateFixture({
          agentId: "aaaa1111-0000-0000-0000-000000000000",
          slotType: "TOP_SCORE",
          rank: 1,
        }),
        candidateFixture({
          agentId: "bbbb2222-0000-0000-0000-000000000000",
          slotType: "EXPLORATION",
          rank: 3,
          reasons: ["新人池确定性选取"],
        }),
      ],
    });
    render(<CandidateSection taskId="task-1" />);

    expect(await screen.findByText("高分候选")).toBeTruthy();
    expect(screen.getByText("新人探索位")).toBeTruthy();
    expect(screen.getByText("新人池确定性选取")).toBeTruthy();
  });

  // Regression for Codex round 1 P2: EXPLORATION must not reuse `success`
  // (green), which this codebase already binds to settlement outcomes
  // (StatusBadge's RELEASED tone) — PRD's own "差异化虚线" alternative
  // (dashed border) is used instead, without inventing a new color.
  it("gives the EXPLORATION card a dashed border and never the settlement (success/green) tone", async () => {
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [candidateFixture({ slotType: "EXPLORATION", rank: 3 })],
    });
    render(<CandidateSection taskId="task-1" />);

    // The reasons list below also renders `<li>` elements (implicit
    // "listitem" role) — the candidate card itself is the first one in
    // document order.
    const items = await screen.findAllByRole("listitem");
    const item = items[0];
    if (!item) throw new Error("expected at least one listitem");
    expect(item.className).toContain("border-dashed");
    // StatusChip's success tone always renders `text-success`/`bg-success` —
    // absence of that class proves EXPLORATION isn't wearing the settlement
    // color.
    expect(item.innerHTML).not.toContain("text-success");
    expect(item.innerHTML).not.toContain("bg-success");
  });

  it("shows an error message when the fetch fails", async () => {
    vi.spyOn(recommendationsApi, "getRecommendations").mockRejectedValue(new Error("network down"));
    render(<CandidateSection taskId="task-1" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
