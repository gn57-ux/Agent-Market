import type { ChainConfig, TaskStatus } from "@agent-market/domain";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetailSections } from "./TaskDetailSections.js";
import * as tasksApi from "./api.js";
import type { TaskRecord } from "./api.js";
import * as recommendationsApi from "../recommendations/api.js";
import * as agentsApi from "../agents/api.js";
import type { Agent } from "../agents/api.js";
import * as deliverablesApi from "../deliverables/api.js";
import { ApiError as DeliverablesApiError } from "../deliverables/api.js";
import * as disputesApi from "../disputes/api.js";

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
  isTestnet: true,
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

// Every remaining TaskStatus variant this suite doesn't otherwise cover —
// kept as a literal list (not derived from the union) so this test fails
// loudly if a status this suite doesn't know about starts rendering
// something. OPEN has its own dedicated tests below (CandidateSection vs.
// AcceptanceSection, T-707/T-802); ACCEPTED/SUBMITTED have their own
// dedicated SubmissionSection tests below (T-908); RELEASED/REFUNDED have
// their own dedicated SettlementSection tests below (T-1004); DISPUTED has
// its own dedicated DisputeSection tests below (T-1005).
const STATUSES_RENDERING_NOTHING: TaskStatus[] = [{ kind: "CANCELLED" }];

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
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ requesterAddress: "0x1111111111111111111111111111111111111111" }),
    );
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

  it.each(STATUSES_RENDERING_NOTHING)(
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

  // T-908 (AC-907): ACCEPTED/SUBMITTED now render SubmissionSection —
  // both need `getTask`/`getLatestDeliverable` mocked, matching
  // SubmissionSection's own "each section fetches its own data" pattern.
  const ACCEPTED_OR_SUBMITTED_STATUSES: TaskStatus[] = [
    { kind: "ACCEPTED", agent: `0x${"2".repeat(40)}` },
    {
      kind: "SUBMITTED",
      agent: `0x${"2".repeat(40)}`,
      submittedAt: "2026-01-01T00:00:00.000Z",
      reviewDeadline: "2026-01-08T00:00:00.000Z",
    },
  ];

  it.each(ACCEPTED_OR_SUBMITTED_STATUSES)(
    "renders SubmissionSection's read-only view for status $kind when signed out (no accepted-Agent session)",
    async (status) => {
      vi.spyOn(tasksApi, "getTask").mockResolvedValue(
        taskFixture({
          status: status.kind,
          acceptedAgentAddress: `0x${"2".repeat(40)}`,
          acceptedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(
        new DeliverablesApiError(404, "该任务尚无成果提交记录。"),
      );
      const { findByText } = render(
        <MemoryRouter>
          <TaskDetailSections status={status} taskId="task-1" />
        </MemoryRouter>,
      );
      // SubmissionSection's own heading — proves the ACCEPTED/SUBMITTED
      // branch rendered the new section (AC-907), not the old `null`.
      expect(await findByText("成果提交")).toBeTruthy();
      expect(await findByText("该任务尚无成果提交记录。")).toBeTruthy();
    },
  );

  it("renders SubmissionSection's upload form for status ACCEPTED when signed in as the accepted Agent", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({
        status: "ACCEPTED",
        acceptedAgentAddress: SESSION_ADDRESS,
        acceptedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(
      new DeliverablesApiError(404, "该任务尚无成果提交记录。"),
    );
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "ACCEPTED", agent: SESSION_ADDRESS }} taskId="task-1" />
      </MemoryRouter>,
    );
    expect(await findByText("成果提交")).toBeTruthy();
    expect(await findByText("计算成果哈希")).toBeTruthy();
  });

  // N4 round 1 P1 (Codex): navigating from one task to another while
  // `SubmissionSection` stays mounted (the same route re-rendering with a
  // new `taskId`, exactly what `react-router`'s `useParams` does) must not
  // let a hash already staged for task A leak into task B's `submitResult`
  // call. `key={taskId}` (TaskDetailSections.tsx) is the fix — this test
  // proves the OBSERVABLE effect (a fresh, reset section) rather than
  // asserting on React internals: a hash computed while viewing task-1
  // must be completely gone once the SAME rendered tree re-renders for
  // task-2, with the upload step starting over from scratch.
  it("resets SubmissionSection's local state (no leaked staged hash) when taskId changes while ACCEPTED (N4 round 1 P1 regression)", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockImplementation((taskId: string) =>
      Promise.resolve(
        taskFixture({
          taskId,
          status: "ACCEPTED",
          acceptedAgentAddress: SESSION_ADDRESS,
          acceptedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(
      new DeliverablesApiError(404, "该任务尚无成果提交记录。"),
    );
    const staleHash = `0x${"f".repeat(64)}` as const;
    vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockResolvedValue({
      deliverableId: "d-1",
      resultHash: staleHash,
      storedAt: "2026-01-01T00:00:00.000Z",
    });

    const status = { kind: "ACCEPTED" as const, agent: SESSION_ADDRESS };
    const { rerender } = render(
      <MemoryRouter>
        <TaskDetailSections status={status} taskId="task-1" />
      </MemoryRouter>,
    );

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "计算成果哈希" }));
    expect(await screen.findByText(staleHash)).toBeTruthy();

    // Same route, same rendered tree, only `taskId` changes — exactly the
    // `useParams` scenario `TaskDetailPage` produces when navigating
    // between two tasks without a full page reload.
    rerender(
      <MemoryRouter>
        <TaskDetailSections status={status} taskId="task-2" />
      </MemoryRouter>,
    );

    // The old task's staged hash must be gone, and the upload step must
    // start fresh — never resurrected for task-2's own submission.
    expect(screen.queryByText(staleHash)).toBeNull();
    expect(await screen.findByRole("button", { name: "计算成果哈希" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交成果" })).toBeNull();
  });

  // T-1004 (AC-1009): RELEASED/REFUNDED now render SettlementSection's
  // final-outcome message instead of rendering nothing.
  it("renders SettlementSection's outcome message for status RELEASED", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "RELEASED" }));
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "RELEASED" }} taskId="task-1" />
      </MemoryRouter>,
    );
    expect(await findByText("结算")).toBeTruthy();
    expect(await findByText("任务已结算：预算与质押已支付给 Agent。")).toBeTruthy();
  });

  it("renders SettlementSection's outcome message for status REFUNDED", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "REFUNDED" }));
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "REFUNDED" }} taskId="task-1" />
      </MemoryRouter>,
    );
    expect(await findByText("任务已结算：预算与质押已退还给需求方。")).toBeTruthy();
  });

  // Codex review (T-1005 round 1, P1): `resolveDispute` moves the task
  // straight from DISPUTED to RELEASED — `DisputeSection` must stay
  // mounted here too, or the arbitration outcome (who was supported)
  // becomes permanently unreadable the instant settlement completes.
  it("renders DisputeSection's outcome alongside SettlementSection's for status RELEASED when the task was settled via a dispute", async () => {
    const requesterAddress = "0x1234567890123456789012345678901234567890";
    mockSession = { status: "signed_in", address: requesterAddress };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "RELEASED", requesterAddress }),
    );
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue({
      disputeId: "dispute-1",
      status: "RESOLVED",
      reason: "交付成果不符合要求",
      resolution: "SUPPORT_AGENT",
      resolvedAt: "2026-01-03T00:00:00.000Z",
    });
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections status={{ kind: "RELEASED" }} taskId="task-1" />
      </MemoryRouter>,
    );
    expect(await findByText("任务已结算：预算与质押已支付给 Agent。")).toBeTruthy();
    expect(await findByText(/支持 Agent，预算和质押已放款给 Agent/)).toBeTruthy();
  });

  // T-1005 (AC-1009's dispute half): SUBMITTED now also renders
  // DisputeSection alongside SubmissionSection/SettlementSection — the
  // requester's own "发起争议" trigger.
  it("renders DisputeSection's trigger for status SUBMITTED when signed in as the requester", async () => {
    const requesterAddress = "0x1234567890123456789012345678901234567890";
    mockSession = { status: "signed_in", address: requesterAddress };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({
        status: "SUBMITTED",
        requesterAddress,
        acceptedAgentAddress: `0x${"2".repeat(40)}`,
        acceptedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(
      new DeliverablesApiError(404, "该任务尚无成果提交记录。"),
    );
    vi.spyOn(disputesApi, "getDispute").mockRejectedValue(
      new disputesApi.ApiError(404, "该任务尚无争议记录。"),
    );
    const { findByRole } = render(
      <MemoryRouter>
        <TaskDetailSections
          status={{
            kind: "SUBMITTED",
            agent: `0x${"2".repeat(40)}`,
            submittedAt: "2026-01-01T00:00:00.000Z",
            reviewDeadline: "2026-01-08T00:00:00.000Z",
          }}
          taskId="task-1"
        />
      </MemoryRouter>,
    );
    expect(await findByRole("button", { name: "发起争议" })).toBeTruthy();
  });

  // T-1005: DISPUTED now renders DisputeSection instead of nothing.
  it("renders DisputeSection for status DISPUTED — requester's read-only view", async () => {
    const requesterAddress = "0x1234567890123456789012345678901234567890";
    mockSession = { status: "signed_in", address: requesterAddress };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "DISPUTED", requesterAddress }),
    );
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue({
      disputeId: "dispute-1",
      status: "OPEN",
      reason: "交付成果不符合要求",
      resolution: null,
      resolvedAt: null,
    });
    const { findByText } = render(
      <MemoryRouter>
        <TaskDetailSections
          status={{ kind: "DISPUTED", agent: `0x${"2".repeat(40)}` }}
          taskId="task-1"
        />
      </MemoryRouter>,
    );
    expect(await findByText("交付成果不符合要求")).toBeTruthy();
    expect(await findByText("仲裁处理中，请等待裁决结果。")).toBeTruthy();
  });

  // Exhaustiveness itself (a missing case failing to compile) is a
  // TypeScript-level guarantee enforced by `assertExhaustive` in the
  // component's `default` branch — not something expressible as a runtime
  // assertion here. The tests above already cover every variant
  // `TaskStatus` currently has (DRAFT/AWAITING_FUNDING render
  // FundingSection; ACCEPTED renders SubmissionSection + SettlementSection;
  // SUBMITTED renders SubmissionSection + SettlementSection +
  // DisputeSection; RELEASED/REFUNDED render SettlementSection; DISPUTED
  // renders DisputeSection; CANCELLED renders null).
});
