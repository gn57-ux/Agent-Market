import type { ChainConfig, TaskStatus } from "@agent-market/domain";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetailSections } from "./TaskDetailSections.js";
import * as tasksApi from "./api.js";
import type { TaskRecord } from "./api.js";
import * as recommendationsApi from "../recommendations/api.js";
import * as agentsApi from "../agents/api.js";
import type { Agent } from "../agents/api.js";

const SESSION_ADDRESS = "0x9999999999999999999999999999999999999999" as const;

// A mutable mock so individual tests can flip between signed-out (Feature
// 7's existing regression coverage) and signed-in-as-a-candidate (this
// Task's new coverage) without a second `vi.mock` factory.
let mockSession: {
  status: "signed_out" | "signed_in";
  address: string | undefined;
} = { status: "signed_out", address: undefined };

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: mockSession.status,
    address: mockSession.address,
    errorMessage: undefined,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

const CHAIN_CONFIG: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: `0x${"2".repeat(40)}` as const,
    ydToken: `0x${"1".repeat(40)}` as const,
    ydFaucet: `0x${"3".repeat(40)}` as const,
  },
};

const readContract = vi.fn().mockResolvedValue(600n);

vi.mock("../wallet/WalletProvider.js", () => ({
  useWallet: () => ({
    connection: { status: "connected", address: SESSION_ADDRESS, chainId: CHAIN_CONFIG.chainId },
    address: SESSION_ADDRESS,
    chainId: CHAIN_CONFIG.chainId,
    chainConfig: CHAIN_CONFIG,
    isCorrectNetwork: true,
    errorMessage: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchNetwork: vi.fn(),
    identityGeneration: 1,
    getIdentityGeneration: () => 1,
    signMessage: vi.fn(),
    getWalletClient: () => ({}),
    getPublicClient: () => ({ readContract }),
  }),
}));

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "11111111-2222-3333-4444-555555555555",
    ownerAddress: "0x0000000000000000000000000000000000000000",
    name: "Agent",
    description: "desc",
    category: "writing",
    skillTags: [],
    authorBio: null,
    invocationUrl: null,
    payoutAddress: "0x0000000000000000000000000000000000000000",
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
    acceptedAgentAddress: null,
    acceptedAt: null,
    ...overrides,
  };
}

// Every non-DRAFT/AWAITING_FUNDING/OPEN variant TaskStatus currently has —
// kept as a literal list (not derived from the union) so this test fails
// loudly if a status this suite doesn't know about starts rendering
// something. OPEN has its own dedicated tests below (CandidateSection vs.
// AcceptanceSection, T-707/T-802).
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

beforeEach(() => {
  mockSession = { status: "signed_out", address: undefined };
  // `vi.restoreAllMocks()` (afterEach, below) resets a plain `vi.fn()` mock
  // back to a no-implementation stub (there is no "original" to restore to,
  // unlike a `vi.spyOn` on a real method) — re-arm it each test rather than
  // letting the previous test's cleanup silently make this one's readContract
  // call resolve to `undefined`.
  readContract.mockResolvedValue(600n);
});

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

  it("renders CandidateSection for status OPEN when signed out (regression, T-707)", async () => {
    const getRecommendationsSpy = vi
      .spyOn(recommendationsApi, "getRecommendations")
      .mockResolvedValue({ recommendations: [] });
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "OPEN" }} taskId="task-1" />
      </MemoryRouter>,
    );
    // CandidateSection's own heading — proves the OPEN branch still
    // delegates to Feature 7's section, not just returned truthy JSX.
    expect(await findByText("推荐候选")).toBeTruthy();
    expect(getRecommendationsSpy).toHaveBeenCalledWith("task-1");
  });

  it("renders CandidateSection for status OPEN when signed in but not a recommended candidate (regression)", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [
        { agentId: "agent-1", rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: [] },
      ],
    });
    // Owned by a different wallet than the signed-in session.
    vi.spyOn(agentsApi, "getAgent").mockResolvedValue(
      agentFixture({
        agentId: "agent-1",
        ownerAddress: "0x1111111111111111111111111111111111111111",
      }),
    );
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "OPEN" }} taskId="task-1" />
      </MemoryRouter>,
    );
    expect(await findByText("推荐候选")).toBeTruthy();
  });

  it("renders AcceptanceSection for status OPEN when the signed-in wallet owns a recommended candidate", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ title: "候选任务" }));
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [
        { agentId: "agent-1", rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: [] },
      ],
    });
    vi.spyOn(agentsApi, "getAgent").mockResolvedValue(
      agentFixture({ agentId: "agent-1", ownerAddress: SESSION_ADDRESS }),
    );
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "OPEN" }} taskId="task-1" />
      </MemoryRouter>,
    );
    // AcceptanceSection's own heading — proves the OPEN branch rendered the
    // new section, not Feature 7's CandidateSection.
    expect(await findByText("接单质押")).toBeTruthy();
    expect(await findByText("候选任务")).toBeTruthy();
    expect(await findByText("质押接单")).toBeTruthy();
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
