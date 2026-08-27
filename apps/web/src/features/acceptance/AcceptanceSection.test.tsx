import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptanceSection } from "./AcceptanceSection.js";
import * as acceptanceApi from "./api.js";
import * as tasksApi from "../tasks/api.js";
import type { TaskRecord } from "../tasks/api.js";
import * as recommendationsApi from "../recommendations/api.js";
import * as agentsApi from "../agents/api.js";
import type { Agent } from "../agents/api.js";

const SESSION_ADDRESS = "0x9999999999999999999999999999999999999999" as const;

let mockSession: {
  status: "signed_out" | "signed_in";
  address: string | undefined;
} = { status: "signed_in", address: SESSION_ADDRESS };

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

const readContract = vi.fn();
// Overridable per-test (default: returns a client backed by `readContract`)
// so a test can simulate `getPublicClient()`'s real synchronous throw when
// no wallet is connected (Codex review, T-802 round 1, P1).
let getPublicClientImpl: () => { readContract: typeof readContract } = () => ({ readContract });

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
    getPublicClient: () => getPublicClientImpl(),
  }),
}));

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "11111111-2222-3333-4444-555555555555",
    ownerAddress: SESSION_ADDRESS,
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
    title: "写一篇文章",
    description: "desc",
    // 1000 YD in minimal units — chosen so a 6% stake (whatever the mocked
    // readContract returns) has an exact, easily-asserted result.
    budget: "1000000000000000000000",
    token: `0x${"1".repeat(40)}` as const,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: [],
    status: "OPEN",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acceptedAgentAddress: null,
    acceptedAt: null,
    ...overrides,
  };
}

function mockAsCandidate() {
  mockSession = { status: "signed_in", address: SESSION_ADDRESS };
  vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
    recommendations: [
      { agentId: "agent-1", rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: [] },
    ],
  });
  vi.spyOn(agentsApi, "getAgent").mockResolvedValue(
    agentFixture({ agentId: "agent-1", ownerAddress: SESSION_ADDRESS }),
  );
}

beforeEach(() => {
  mockSession = { status: "signed_in", address: SESSION_ADDRESS };
  readContract.mockReset();
  getPublicClientImpl = () => ({ readContract });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AcceptanceSection", () => {
  it("shows the task's title/category/budget/deadline once the viewer is confirmed as a candidate", async () => {
    mockAsCandidate();
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    readContract.mockResolvedValue(600n);

    render(<AcceptanceSection taskId="task-1" />);

    expect(await screen.findByText("写一篇文章")).toBeTruthy();
    expect(screen.getByText("writing")).toBeTruthy();
    expect(screen.getByText("1000 YD")).toBeTruthy();
    expect(screen.getByText(new Date("2033-01-01T00:00:00.000Z").toLocaleString())).toBeTruthy();
  });

  it("computes the displayed stake from whatever STAKE_RATE_BPS the read-only call returns, times the task's budget", async () => {
    mockAsCandidate();
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ budget: "1000000000000000000000" }),
    );
    // Deliberately NOT 600 — proves the component multiplies the read-only
    // return value itself rather than hardcoding the contract's current
    // rate (capsule: "不编写任何测试断言这个数值等于某个'正确'质押值").
    readContract.mockResolvedValue(1234n);

    render(<AcceptanceSection taskId="task-1" />);

    await screen.findByText("写一篇文章");
    // stake = 1000 * 1234 / 10000 = 123.4 YD
    await waitFor(() => expect(screen.getByText("123.4 YD")).toBeTruthy());
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: CHAIN_CONFIG.addresses.taskEscrow,
        functionName: "STAKE_RATE_BPS",
      }),
    );
  });

  it("disables the 质押接单 button while stake is still undefined", async () => {
    mockAsCandidate();
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    // Never resolves — stake stays undefined for the life of this test.
    readContract.mockReturnValue(new Promise(() => undefined));

    render(<AcceptanceSection taskId="task-1" />);

    const button = await screen.findByRole("button", { name: "质押接单" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("opens an ActionSheet mounting AcceptConfirmContent when 质押接单 is clicked (T-803)", async () => {
    mockAsCandidate();
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    readContract.mockResolvedValue(600n);
    const permitSpy = vi
      .spyOn(acceptanceApi, "getAcceptancePermitForAgent")
      .mockReturnValue(new Promise(() => undefined));

    render(<AcceptanceSection taskId="task-1" />);

    const button = await screen.findByRole("button", { name: "质押接单" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    expect(await screen.findByText("确认质押接单")).toBeTruthy();
    // T-807: `AcceptanceSection` must have resolved WHICH `agentId` matched
    // the signed-in wallet (not just a boolean "is a candidate") and passed
    // it through as a prop — verified here via the specific `agentId`
    // `AcceptConfirmContent` actually called the new per-agent permit
    // endpoint with, matching this file's existing style of asserting
    // through the real API call rather than mocking the child component.
    expect(permitSpy).toHaveBeenCalledWith("task-1", "agent-1");
  });

  // T-807: `resolveCandidateAgentId` (the renamed/reworked `resolveIsCandidate`)
  // must resolve the SPECIFIC matching `agentId`, not just a boolean — this
  // is what lets it be threaded through to `AcceptConfirmContent` correctly
  // when the task has multiple recommended candidates and only one is owned
  // by the signed-in wallet.
  it("resolves and passes the specific matching agentId when multiple candidates are recommended", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [
        { agentId: "agent-other", rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: [] },
        { agentId: "agent-mine", rank: 2, slotType: "TOP_SCORE", score: 0.8, reasons: [] },
      ],
    });
    vi.spyOn(agentsApi, "getAgent").mockImplementation((agentId: string) =>
      Promise.resolve(
        agentFixture({
          agentId,
          ownerAddress:
            agentId === "agent-mine"
              ? SESSION_ADDRESS
              : "0x1111111111111111111111111111111111111111",
        }),
      ),
    );
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    readContract.mockResolvedValue(600n);
    const permitSpy = vi
      .spyOn(acceptanceApi, "getAcceptancePermitForAgent")
      .mockReturnValue(new Promise(() => undefined));

    render(<AcceptanceSection taskId="task-1" />);

    const button = await screen.findByRole("button", { name: "质押接单" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    await screen.findByText("确认质押接单");
    expect(permitSpy).toHaveBeenCalledWith("task-1", "agent-mine");
  });

  // T-807 round 2, human N4 BLOCK fix (Codex): the backend explicitly
  // supports and tests a single wallet owning MULTIPLE Agent records, more
  // than one of which can be recommended for the same task
  // (`routes.integration.test.ts`'s "returns each candidate's own
  // independent permit when the same wallet owns two recommended
  // candidates"). A prior version of `resolveCandidateAgentId` silently
  // picked only the first match — this verifies the fix: both owned
  // candidates are offered, an explicit pick is required before the sheet
  // can open, and the confirm flow acts as whichever one was actually
  // selected (not always the first).
  it("requires an explicit pick and acts as the selected agent when the wallet owns two recommended candidates", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [
        { agentId: "agent-a", rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: [] },
        { agentId: "agent-b", rank: 2, slotType: "EXPLORATION", score: 0.5, reasons: [] },
      ],
    });
    vi.spyOn(agentsApi, "getAgent").mockImplementation((agentId: string) =>
      Promise.resolve(
        agentFixture({
          agentId,
          ownerAddress: SESSION_ADDRESS, // both owned by the same wallet
          name: agentId === "agent-a" ? "Agent A" : "Agent B",
        }),
      ),
    );
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    readContract.mockResolvedValue(600n);
    const permitSpy = vi
      .spyOn(acceptanceApi, "getAcceptancePermitForAgent")
      .mockReturnValue(new Promise(() => undefined));

    render(<AcceptanceSection taskId="task-1" />);

    await screen.findByText("Agent A");
    screen.getByText("Agent B");
    const button = await screen.findByRole("button", { name: "质押接单" });
    // No candidate picked yet — the button must stay disabled rather than
    // defaulting to either agent.
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(permitSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "Agent B" }));
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    await screen.findByText("确认质押接单");
    expect(permitSpy).toHaveBeenCalledWith("task-1", "agent-b");
  });

  it("falls back to Feature 7's CandidateSection when the signed-in wallet is not a recommended candidate", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    vi.spyOn(recommendationsApi, "getRecommendations").mockResolvedValue({
      recommendations: [
        { agentId: "agent-1", rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: [] },
      ],
    });
    vi.spyOn(agentsApi, "getAgent").mockResolvedValue(
      agentFixture({
        agentId: "agent-1",
        ownerAddress: "0x1111111111111111111111111111111111111111",
      }),
    );
    const getTaskSpy = vi.spyOn(tasksApi, "getTask");

    render(<AcceptanceSection taskId="task-1" />);

    expect(await screen.findByText("推荐候选")).toBeTruthy();
    // Not a candidate → never needs the task record for its own display.
    expect(getTaskSpy).not.toHaveBeenCalled();
  });

  it("falls back to Feature 7's CandidateSection when signed out", async () => {
    mockSession = { status: "signed_out", address: undefined };
    const getRecommendationsSpy = vi
      .spyOn(recommendationsApi, "getRecommendations")
      .mockResolvedValue({ recommendations: [] });

    render(<AcceptanceSection taskId="task-1" />);

    expect(await screen.findByText("暂无合适 Agent")).toBeTruthy();
    expect(getRecommendationsSpy).toHaveBeenCalledWith("task-1");
  });

  // Regression for Codex round 1 P2: a candidacy-check failure (the
  // GET .../recommendations call itself failing) must fail open to
  // CandidateSection, not be shown as an "error" state — only a `getTask`
  // failure AFTER candidacy is already confirmed should surface as an error.
  it("falls back to CandidateSection (not an error state) when the candidacy check itself fails", async () => {
    mockSession = { status: "signed_in", address: SESSION_ADDRESS };
    // Fails only AcceptanceSection's own candidacy-check call; the fallback
    // CandidateSection then makes its OWN independent
    // `getRecommendations` call (Feature 7, unrelated to this Task's fix),
    // which must succeed so this test isolates "did AcceptanceSection fail
    // open" from "did CandidateSection's own unrelated fetch also fail".
    vi.spyOn(recommendationsApi, "getRecommendations")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ recommendations: [] });
    const getTaskSpy = vi.spyOn(tasksApi, "getTask");

    render(<AcceptanceSection taskId="task-1" />);

    expect(await screen.findByText("推荐候选")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getTaskSpy).not.toHaveBeenCalled();
  });

  // Regression for Codex round 2 P2: a `getTask` failure that is NOT an
  // `ApiError` (e.g. `fetch` itself rejecting with a raw `TypeError` for a
  // transport-level failure — offline/DNS/CORS, never reaching apiFetch's
  // `ApiError`-throwing branch) must still surface as this component's own
  // error state, not be misclassified as "not a candidate" (which would
  // misleadingly render the confirmed candidate as ineligible).
  it("shows its own error state (not a fallback) when getTask fails with a non-ApiError", async () => {
    mockAsCandidate();
    vi.spyOn(tasksApi, "getTask").mockRejectedValue(new TypeError("Failed to fetch"));

    render(<AcceptanceSection taskId="task-1" />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("推荐候选")).toBeNull();
  });

  // Regression for Codex round 1 P1: `getPublicClient()` throws
  // SYNCHRONOUSLY when no wallet is connected (its real implementation,
  // WalletProvider.tsx) — this must not crash the render; the stake line
  // should just stay in its "读取中…" placeholder state.
  it("does not crash when getPublicClient() throws synchronously (wallet disconnected)", async () => {
    mockAsCandidate();
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    getPublicClientImpl = () => {
      throw new Error("请先连接 MetaMask 钱包，再读取链上数据。");
    };

    render(<AcceptanceSection taskId="task-1" />);

    expect(await screen.findByText("写一篇文章")).toBeTruthy();
    expect(screen.getByText("读取中…")).toBeTruthy();
  });
});
