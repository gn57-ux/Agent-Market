import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminDashboardPage } from "./AdminDashboardPage.js";
import * as adminApi from "./api.js";
import type { AdminDashboard } from "./api.js";
import { ApiError } from "../../shared/api/client.js";

const ADMIN_A_ADDRESS = "0x1234567890123456789012345678901234567890";
const ADMIN_B_ADDRESS = "0x9876543210987654321098765432109876543210";

let mockSessionStatus: "signed_out" | "signing_in" | "signed_in" | "error" = "signed_in";
let mockSessionAddress: string = ADMIN_A_ADDRESS;

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: mockSessionStatus,
    address: mockSessionStatus === "signed_in" ? mockSessionAddress : undefined,
    errorMessage: undefined,
    login: vi.fn(),
    loginWithPrivy: vi.fn(),
    logout: vi.fn(),
  }),
}));

function makeDashboard(overrides: Partial<AdminDashboard> = {}): AdminDashboard {
  return {
    publishedTaskCount: 3,
    publishedAgentCount: 2,
    reviewQueue: {
      items: [
        {
          agentId: "agent-1",
          ownerAddress: "0xowner1owner1owner1owner1owner1owner1owne",
          name: "Copy Polisher",
          category: "writing",
          status: "ACTIVE",
          reviewStatus: "PENDING_REVIEW",
          pricingType: "PER_TASK",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
    },
    openDisputes: [
      {
        disputeId: "dispute-1",
        taskId: "task-1",
        requesterAddress: "0xrequester1requester1requester1requester1",
        reason: "结果不符合要求",
        status: "OPEN",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    platformFunds: {
      totalEscrowed: "1000",
      totalReleased: "400",
      totalRefunded: "100",
      activeLocked: "500",
    },
    metrics: {
      windowDays: 7,
      tasksPublishedInWindow: 2,
      tasksCompletedInWindow: 1,
      disputesInWindow: 1,
      pendingReviewCount: 1,
    },
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminDashboardPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  mockSessionStatus = "signed_in";
  mockSessionAddress = ADMIN_A_ADDRESS;
  vi.restoreAllMocks();
});

describe("AdminDashboardPage", () => {
  it("prompts sign-in when not signed in, and never calls the API", () => {
    mockSessionStatus = "signed_out";
    const spy = vi.spyOn(adminApi, "getAdminDashboard");
    renderPage();

    expect(screen.getByText("登录钱包身份后才能访问管理 Dashboard。")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows a loading state while the request is in flight", () => {
    vi.spyOn(adminApi, "getAdminDashboard").mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("加载中…")).toBeTruthy();
  });

  it("shows the forbidden state for a signed-in non-admin (403)", async () => {
    vi.spyOn(adminApi, "getAdminDashboard").mockRejectedValue(
      new ApiError(403, "该操作仅限管理员执行。"),
    );
    renderPage();

    expect(
      await screen.findByText("该操作仅限管理员执行，您当前登录的地址不是管理员。"),
    ).toBeTruthy();
  });

  it("shows a generic error message for a non-403 failure", async () => {
    vi.spyOn(adminApi, "getAdminDashboard").mockRejectedValue(new ApiError(500, "服务器内部错误"));
    renderPage();

    expect(await screen.findByText("服务器内部错误")).toBeTruthy();
  });

  it("renders every section's data for an admin", async () => {
    vi.spyOn(adminApi, "getAdminDashboard").mockResolvedValue(makeDashboard());
    renderPage();

    expect(await screen.findByText("Copy Polisher")).toBeTruthy();
    expect(screen.getByText("结果不符合要求")).toBeTruthy();
    expect(screen.getByText("1000")).toBeTruthy(); // totalEscrowed
    expect(screen.getByText("400")).toBeTruthy(); // totalReleased
    expect(screen.getByText("待审核 Agent（1）")).toBeTruthy();
  });

  it("shows empty-state messages for an empty review queue and no open disputes", async () => {
    vi.spyOn(adminApi, "getAdminDashboard").mockResolvedValue(
      makeDashboard({
        reviewQueue: { items: [], total: 0 },
        openDisputes: [],
        metrics: {
          windowDays: 7,
          tasksPublishedInWindow: 0,
          tasksCompletedInWindow: 0,
          disputesInWindow: 0,
          pendingReviewCount: 0,
        },
      }),
    );
    renderPage();

    expect(await screen.findByText("当前没有待审核的 Agent。")).toBeTruthy();
    expect(screen.getByText("当前没有未解决的争议。")).toBeTruthy();
  });

  it("re-fetches when session status transitions from signed_out to signed_in", async () => {
    mockSessionStatus = "signed_out";
    const spy = vi.spyOn(adminApi, "getAdminDashboard").mockResolvedValue(makeDashboard());
    const { rerender } = renderPage();
    expect(spy).not.toHaveBeenCalled();

    mockSessionStatus = "signed_in";
    rerender(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it(
    "never paints a previous admin's dashboard data to a newly-signed-in DIFFERENT address " +
      "(Codex review, T-1609 round 1 P1 — cross-session data leak)",
    async () => {
      mockSessionStatus = "signed_in";
      mockSessionAddress = ADMIN_A_ADDRESS;
      const spy = vi
        .spyOn(adminApi, "getAdminDashboard")
        .mockResolvedValueOnce(makeDashboard({ publishedTaskCount: 111 }));
      const { rerender } = renderPage();
      expect(await screen.findByText("111")).toBeTruthy();

      // Admin A logs out, then a DIFFERENT admin (B) signs in — the second
      // fetch is deliberately left pending (never resolved in this test)
      // to prove the render itself refuses to show A's stale data while
      // B's own fetch is still in flight, rather than relying on the fetch
      // completing quickly enough to "outrun" the leak.
      mockSessionStatus = "signed_out";
      rerender(
        <MemoryRouter>
          <AdminDashboardPage />
        </MemoryRouter>,
      );
      expect(screen.queryByText("111")).toBeNull();

      mockSessionStatus = "signed_in";
      mockSessionAddress = ADMIN_B_ADDRESS;
      spy.mockReturnValueOnce(new Promise(() => {})); // never resolves
      rerender(
        <MemoryRouter>
          <AdminDashboardPage />
        </MemoryRouter>,
      );

      // Must show loading, NEVER Admin A's "111" — this is the actual
      // regression assertion; a component missing the forAddress guard
      // would render the stale ready state here since B's own fetch
      // hasn't resolved yet.
      expect(screen.getByText("加载中…")).toBeTruthy();
      expect(screen.queryByText("111")).toBeNull();
    },
  );

  it(
    "never paints a previous session's forbidden/error result to a newly-signed-in " +
      "DIFFERENT address (Codex review, T-1609 round 2 P2)",
    async () => {
      mockSessionStatus = "signed_in";
      mockSessionAddress = ADMIN_A_ADDRESS;
      const spy = vi
        .spyOn(adminApi, "getAdminDashboard")
        .mockRejectedValueOnce(new ApiError(403, "该操作仅限管理员执行。"));
      const { rerender } = renderPage();
      expect(
        await screen.findByText("该操作仅限管理员执行，您当前登录的地址不是管理员。"),
      ).toBeTruthy();

      // A real admin (B) now signs in — the second fetch is deliberately
      // left pending, to prove the render itself refuses to show A's stale
      // "forbidden" result while B's own fetch is still in flight.
      mockSessionStatus = "signed_in";
      mockSessionAddress = ADMIN_B_ADDRESS;
      spy.mockReturnValueOnce(new Promise(() => {})); // never resolves
      rerender(
        <MemoryRouter>
          <AdminDashboardPage />
        </MemoryRouter>,
      );

      expect(screen.getByText("加载中…")).toBeTruthy();
      expect(screen.queryByText("该操作仅限管理员执行，您当前登录的地址不是管理员。")).toBeNull();
    },
  );
});
