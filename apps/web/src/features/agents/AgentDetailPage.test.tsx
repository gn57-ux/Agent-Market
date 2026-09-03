import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDetailPage } from "./AgentDetailPage.js";
import * as agentsApi from "./api.js";
import type { Agent } from "./api.js";

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: "signed_out",
    address: undefined,
    errorMessage: undefined,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "agent-1",
    ownerAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    name: "Copy Polisher",
    description: "desc",
    category: "writing",
    skillTags: ["copywriting"],
    authorBio: null,
    invocationUrl: null,
    payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    pricingModel: null,
    pricingType: "FREE",
    referencePrice: null,
    status: "ACTIVE",
    reviewStatus: "ACTIVE",
    completedTaskCount: 3,
    successCount: 2,
    overdueCount: 1,
    qualityScore: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    protocolVersion: "v1",
    ...overrides,
  };
}

function renderPage(agentId = "agent-1") {
  return render(
    <MemoryRouter initialEntries={[`/agents/${agentId}`]}>
      <Routes>
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentDetailPage", () => {
  // T-1006 (AC-1010's back half): the detail surface must show the same
  // "暂无评分" — never a number or star rating — for a null qualityScore
  // that AgentMarketPage's list already has its own regression test for.
  // Both go through the SAME shared `QualityScoreLabel`, but until now
  // only the list surface had automated evidence; this file did not exist.
  it("shows '暂无评分' — never a number — for a null qualityScore", async () => {
    vi.spyOn(agentsApi, "getAgent").mockResolvedValue(agentFixture({ qualityScore: null }));
    renderPage();

    expect(await screen.findByText("Copy Polisher")).toBeTruthy();
    expect(screen.getByText("暂无评分")).toBeTruthy();
    expect(screen.queryByText(/质量分：/)).toBeNull();
  });

  it("shows the actual score for a non-null qualityScore", async () => {
    vi.spyOn(agentsApi, "getAgent").mockResolvedValue(agentFixture({ qualityScore: 0.75 }));
    renderPage();

    expect(await screen.findByText("质量分：0.75")).toBeTruthy();
    expect(screen.queryByText("暂无评分")).toBeNull();
  });
});
