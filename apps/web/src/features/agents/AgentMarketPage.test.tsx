import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMarketPage } from "./AgentMarketPage.js";
import * as agentsApi from "./api.js";
import type { Agent } from "./api.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
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
    referencePrice: null,
    status: "ACTIVE",
    completedTaskCount: 0,
    successCount: 0,
    overdueCount: 0,
    qualityScore: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentMarketPage", () => {
  it("renders listed Agents with a 'no rating yet' label for a null qualityScore, never as a number", async () => {
    vi.spyOn(agentsApi, "listAgents").mockResolvedValue({
      items: [makeAgent({ qualityScore: null })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    render(
      <MemoryRouter>
        <AgentMarketPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Copy Polisher")).toBeTruthy();
    expect(screen.getByText("暂无评分")).toBeTruthy();
    expect(screen.queryByText("质量分：0.00")).toBeNull();
  });

  it("renders a real qualityScore when present", async () => {
    vi.spyOn(agentsApi, "listAgents").mockResolvedValue({
      items: [makeAgent({ qualityScore: 0.87 })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    render(
      <MemoryRouter>
        <AgentMarketPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("质量分：0.87")).toBeTruthy();
  });

  it("shows an empty-state message when no Agents match", async () => {
    vi.spyOn(agentsApi, "listAgents").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });

    render(
      <MemoryRouter>
        <AgentMarketPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("暂无符合条件的 Agent。")).toBeTruthy();
  });
});
