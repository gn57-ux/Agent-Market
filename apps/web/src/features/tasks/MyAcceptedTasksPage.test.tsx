import type { ChainConfig } from "@agent-market/domain";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyAcceptedTasksPage } from "./MyAcceptedTasksPage.js";
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
// Independently configurable from `mockAddress` (wallet), same reasoning as
// MyPublishedTasksPage.test.tsx: this page must query using the
// AUTHENTICATED session address, never whatever `wallet.address` currently
// reports.
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
    requesterAddress: OTHER_ADDRESS,
    category: "writing",
    title: "My accepted task",
    description: "desc",
    budget: "1000000000000000000",
    token: CHAIN_CONFIG.addresses.ydToken,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: [],
    status: "ACCEPTED",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acceptedAgentAddress: ADDRESS,
    acceptedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MyAcceptedTasksPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  mockAddress = ADDRESS;
  mockSessionStatus = "signed_in";
  mockSessionAddress = ADDRESS;
  vi.restoreAllMocks();
});

describe("MyAcceptedTasksPage", () => {
  it("prompts to connect a wallet instead of loading a list when disconnected", () => {
    mockAddress = undefined;
    renderPage();
    expect(screen.getByText("请先连接 MetaMask 钱包，才能查看你的接单记录。")).toBeTruthy();
  });

  it("does not fetch the list, and prompts to sign in, when wallet is connected but the session is not signed in", async () => {
    mockSessionStatus = "signed_out";
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks");

    renderPage();

    expect(await screen.findByText("请先登录以查看你的接单记录。")).toBeTruthy();
    expect(listTasksSpy).not.toHaveBeenCalled();
  });

  it("fetches the AUTHENTICATED session address's accepted tasks via acceptedBy and renders them", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [
        taskFixture({ taskId: "task-1", status: "ACCEPTED" }),
        taskFixture({ taskId: "task-2", status: "SUBMITTED" }),
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenCalledWith({ acceptedBy: ADDRESS, page: 1 }),
    );
    expect(await screen.findAllByText("My accepted task")).toHaveLength(2);
    expect(document.querySelector('[data-task-id="task-1"]')).toBeTruthy();
    expect(document.querySelector('[data-task-id="task-2"]')).toBeTruthy();
  });

  it("queries with the AUTHENTICATED session address, never the wallet's current (possibly different) address", async () => {
    mockAddress = OTHER_ADDRESS;
    mockSessionAddress = ADDRESS;
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ taskId: "task-1" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenCalledWith({ acceptedBy: ADDRESS, page: 1 }),
    );
    expect(listTasksSpy).not.toHaveBeenCalledWith({ acceptedBy: OTHER_ADDRESS, page: 1 });
  });

  it("links a task card to its detail route", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ taskId: "task-1" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();
    await screen.findByText("My accepted task");

    const card = document.querySelector('[data-task-id="task-1"]');
    expect(card).toBeTruthy();
    const link = card?.closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/tasks/task-1");
  });

  it("paginates past the backend's default 20-item page", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ taskId: "task-1" })],
      total: 25,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    await screen.findByText("第 1 页 / 共 25 条");
    const nextButton = screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(false);

    listTasksSpy.mockResolvedValue({
      items: [taskFixture({ taskId: "task-21", title: "Task 21" })],
      total: 25,
      page: 2,
      pageSize: 20,
    });
    nextButton.click();

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({ acceptedBy: ADDRESS, page: 2 }),
    );
    expect(await screen.findByText("Task 21")).toBeTruthy();
  });

  it("resets to page 1 when the authenticated session address changes", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValueOnce({
      items: [taskFixture({ taskId: "task-1" })],
      total: 25,
      page: 1,
      pageSize: 20,
    });
    listTasksSpy.mockResolvedValueOnce({
      items: [taskFixture({ taskId: "task-21", title: "Task 21" })],
      total: 25,
      page: 2,
      pageSize: 20,
    });

    const { rerender } = renderPage();
    await screen.findByText("My accepted task");
    const nextButton = screen.getByRole("button", { name: "下一页" });
    nextButton.click();
    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({ acceptedBy: ADDRESS, page: 2 }),
    );
    await screen.findByText("Task 21");

    mockSessionAddress = OTHER_ADDRESS;
    listTasksSpy.mockResolvedValue({
      items: [taskFixture({ taskId: "task-other-1", title: "Other agent task" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    rerender(
      <MemoryRouter>
        <MyAcceptedTasksPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({ acceptedBy: OTHER_ADDRESS, page: 1 }),
    );
    expect(await screen.findByText("Other agent task")).toBeTruthy();
  });

  it("shows an empty-state message when the agent has no accepted tasks", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    renderPage();
    expect(await screen.findByText("你还没有接过任务。")).toBeTruthy();
  });

  it("keeps pagination visible (with a way back to page 1) when the current page's items are empty but total is nonzero", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [],
      total: 5,
      page: 2,
      pageSize: 20,
    });
    renderPage();

    expect(await screen.findByText("你还没有接过任务。")).toBeTruthy();
    const prevButton = screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    expect(prevButton.disabled).toBe(false);
    expect(screen.getByText("第 2 页 / 共 5 条")).toBeTruthy();
  });

  it("re-fetches the same data on remount, staying consistent after a 'refresh' (AC-805)", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ taskId: "task-1", status: "ACCEPTED" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const { unmount } = renderPage();
    await screen.findByText("My accepted task");
    unmount();

    renderPage();
    await screen.findByText("My accepted task");

    expect(listTasksSpy).toHaveBeenCalledTimes(2);
    expect(listTasksSpy).toHaveBeenNthCalledWith(1, { acceptedBy: ADDRESS, page: 1 });
    expect(listTasksSpy).toHaveBeenNthCalledWith(2, { acceptedBy: ADDRESS, page: 1 });
  });
});
