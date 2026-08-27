import type { ChainConfig } from "@agent-market/domain";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyPublishedTasksPage } from "./MyPublishedTasksPage.js";
import * as tasksApi from "./api.js";
import type { TaskRecord } from "./api.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const OTHER_ADDRESS = "0x9876543210987654321098765432109876543210" as const;
const CHAIN_CONFIG: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: `0x${"2".repeat(40)}` as const,
    ydToken: `0x${"1".repeat(40)}` as const,
    ydFaucet: `0x${"3".repeat(40)}` as const,
  },
};

let mockAddress: `0x${string}` | undefined = ADDRESS;
let mockSessionStatus: "signed_out" | "signing_in" | "signed_in" | "error" = "signed_in";
// Independently configurable from `mockAddress` (wallet) — the whole point
// of the round 3 fix is that this page must query using the AUTHENTICATED
// session address, never whatever `wallet.address` currently reports (they
// can diverge, e.g. right after an account switch before re-signing in).
let mockSessionAddress: `0x${string}` | undefined = ADDRESS;

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: mockSessionStatus,
    address: mockSessionStatus === "signed_in" ? mockSessionAddress : undefined,
    errorMessage: undefined,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("../wallet/WalletProvider.js", () => ({
  useWallet: () => ({
    connection:
      mockAddress === undefined
        ? { status: "disconnected" }
        : {
            status: "connected",
            address: mockAddress,
            chainId: CHAIN_CONFIG.chainId,
            ydBalance: { status: "ready", amount: 0n, decimals: 18, formatted: "0" },
          },
    address: mockAddress,
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
    getWalletClient: vi.fn(),
    getPublicClient: vi.fn(),
  }),
}));

function taskFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: ADDRESS,
    category: "writing",
    title: "My published task",
    description: "desc",
    budget: "1000000000000000000",
    token: CHAIN_CONFIG.addresses.ydToken,
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

function renderPage() {
  return render(
    <MemoryRouter>
      <MyPublishedTasksPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  mockAddress = ADDRESS;
  mockSessionStatus = "signed_in";
  mockSessionAddress = ADDRESS;
  vi.restoreAllMocks();
});

describe("MyPublishedTasksPage", () => {
  it("prompts to connect a wallet instead of loading a list when disconnected", () => {
    mockAddress = undefined;
    renderPage();
    expect(screen.getByText("请先连接 MetaMask 钱包，才能查看你发布的任务。")).toBeTruthy();
  });

  it("fetches the connected address's own tasks and renders them via TaskCard", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [
        taskFixture({ taskId: "task-1", status: "DRAFT" }),
        taskFixture({ taskId: "task-2", status: "OPEN" }),
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledWith({ requester: ADDRESS, page: 1 }));
    expect(await screen.findAllByText("My published task")).toHaveLength(2);
    expect(document.querySelector('[data-task-id="task-1"]')).toBeTruthy();
    expect(document.querySelector('[data-task-id="task-2"]')).toBeTruthy();
  });

  it("links a task card to its detail route now that /tasks/:taskId exists (T-608)", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ taskId: "task-1", status: "OPEN" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();
    await screen.findByText("My published task");

    const card = document.querySelector('[data-task-id="task-1"]');
    expect(card).toBeTruthy();
    const link = card?.closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/tasks/task-1");
  });

  it("queries with the AUTHENTICATED session address, never the wallet's current (possibly different) address (human review, T-606 round 3)", async () => {
    // The wallet now reports a DIFFERENT address than the one the session
    // was actually established for (e.g. the user switched accounts in
    // MetaMask without re-signing in). The list must still be scoped to
    // `mockSessionAddress` (the authenticated identity) — never silently
    // switch to querying the new, unauthenticated `mockAddress`, which
    // would either ask about the wrong person or (since it wouldn't match
    // the real session) get demoted to the public-only subset while this
    // page still claims to show the complete "我的发布" list.
    mockAddress = OTHER_ADDRESS;
    mockSessionAddress = ADDRESS;
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ taskId: "task-1", status: "DRAFT" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    await waitFor(() => expect(listTasksSpy).toHaveBeenCalledWith({ requester: ADDRESS, page: 1 }));
    expect(listTasksSpy).not.toHaveBeenCalledWith({ requester: OTHER_ADDRESS, page: 1 });
  });

  it("does not fetch the list, and prompts to sign in, when wallet is connected but the session is not signed in (Codex round 2 P1)", async () => {
    mockSessionStatus = "signed_out";
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks");

    renderPage();

    expect(await screen.findByText(/请先登录以查看包含草稿在内的完整发布记录/)).toBeTruthy();
    expect(listTasksSpy).not.toHaveBeenCalled();
  });

  it("paginates past the backend's default 20-item page, not silently truncating a requester with more published tasks (Codex round 1 P1)", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ taskId: "task-1", status: "OPEN" })],
      total: 25,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    await screen.findByText("第 1 页 / 共 25 条");
    const nextButton = screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(false);

    listTasksSpy.mockResolvedValue({
      items: [taskFixture({ taskId: "task-21", status: "OPEN", title: "Task 21" })],
      total: 25,
      page: 2,
      pageSize: 20,
    });
    nextButton.click();

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({ requester: ADDRESS, page: 2 }),
    );
    expect(await screen.findByText("Task 21")).toBeTruthy();
  });

  it("resets to page 1 when the authenticated session address changes (Codex round 2 P2)", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValueOnce({
      items: [taskFixture({ taskId: "task-1", status: "OPEN" })],
      total: 25,
      page: 1,
      pageSize: 20,
    });
    listTasksSpy.mockResolvedValueOnce({
      items: [taskFixture({ taskId: "task-21", status: "OPEN", title: "Task 21" })],
      total: 25,
      page: 2,
      pageSize: 20,
    });

    const { rerender } = renderPage();
    await screen.findByText("My published task");
    const nextButton = screen.getByRole("button", { name: "下一页" });
    nextButton.click();
    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({ requester: ADDRESS, page: 2 }),
    );
    await screen.findByText("Task 21");

    // Sign in as a DIFFERENT address without unmounting — without the P2
    // fix, the component would stay on `page: 2` and query the new
    // address's page 2 directly, which (if it has fewer tasks) would render
    // a false empty state with the pagination controls hidden.
    mockSessionAddress = OTHER_ADDRESS;
    listTasksSpy.mockResolvedValue({
      items: [taskFixture({ taskId: "task-other-1", status: "OPEN", title: "Other user task" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    rerender(
      <MemoryRouter>
        <MyPublishedTasksPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({ requester: OTHER_ADDRESS, page: 1 }),
    );
    expect(await screen.findByText("Other user task")).toBeTruthy();
  });

  it("shows an empty-state message when the requester has no published tasks", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    renderPage();
    expect(await screen.findByText("你还没有发布过任务。")).toBeTruthy();
  });

  it("keeps pagination visible (with a way back to page 1) when the current page's items are empty but total is nonzero (Codex round 1 P2)", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [],
      total: 5,
      page: 2,
      pageSize: 20,
    });
    renderPage();

    expect(await screen.findByText("你还没有发布过任务。")).toBeTruthy();
    const prevButton = screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    expect(prevButton.disabled).toBe(false);
    expect(screen.getByText("第 2 页 / 共 5 条")).toBeTruthy();
  });

  // T-1006 (AC-1009: "列表状态与详情页一致"): DISPUTED/RELEASED/REFUNDED
  // already flow through the same `toTaskStatus`/`TaskCard`/`StatusBadge`
  // pipeline every other status does — this is the automated evidence that
  // the list actually renders them correctly, not just an assumption.
  it("renders the correct status label for DISPUTED, RELEASED, and REFUNDED tasks (list/detail consistency, AC-1009)", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [
        taskFixture({ taskId: "task-disputed", title: "Disputed task", status: "DISPUTED" }),
        taskFixture({ taskId: "task-released", title: "Released task", status: "RELEASED" }),
        taskFixture({ taskId: "task-refunded", title: "Refunded task", status: "REFUNDED" }),
      ],
      total: 3,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    expect(await screen.findByText("争议中")).toBeTruthy();
    expect(screen.getByText("已放款")).toBeTruthy();
    expect(screen.getByText("已退款")).toBeTruthy();
  });
});
