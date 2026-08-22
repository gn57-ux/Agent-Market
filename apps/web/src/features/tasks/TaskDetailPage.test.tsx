import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetailPage } from "./TaskDetailPage.js";
import { ApiError } from "../../shared/api/client.js";
import * as tasksApi from "./api.js";
import type { TaskRecord } from "./api.js";

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
    title: "Detail page task",
    description: "a full description",
    budget: "1000000000000000000",
    token: `0x${"1".repeat(40)}` as const,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: ["solidity"],
    status: "OPEN",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage(taskId = "task-1") {
  return render(
    <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskDetailPage", () => {
  it("shows a loading state before the response resolves", () => {
    vi.spyOn(tasksApi, "getTask").mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("加载中…")).toBeTruthy();
  });

  it("fetches by taskId and renders the title, status badge, and basic fields", async () => {
    const getTaskSpy = vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    renderPage("task-1");

    await waitFor(() => expect(getTaskSpy).toHaveBeenCalledWith("task-1"));
    expect(await screen.findByText("Detail page task")).toBeTruthy();
    expect(screen.getByText("招募中")).toBeTruthy();
    expect(screen.getByText("a full description")).toBeTruthy();
  });

  it("shows a not-found message on a 404 (private task not owned by viewer, or nonexistent)", async () => {
    vi.spyOn(tasksApi, "getTask").mockRejectedValue(new ApiError(404, "not found"));
    renderPage();
    expect(await screen.findByText("未找到该任务。")).toBeTruthy();
  });

  it("shows an error message for a non-404 failure", async () => {
    vi.spyOn(tasksApi, "getTask").mockRejectedValue(new Error("network down"));
    renderPage();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("renders TaskDetailSections' FundingSection for a DRAFT task", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "DRAFT" }));
    renderPage();
    expect(await screen.findByText("资金锁定")).toBeTruthy();
  });

  it("renders no FundingSection for an OPEN task", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "OPEN" }));
    renderPage();
    await screen.findByText("Detail page task");
    expect(screen.queryByText("资金锁定")).toBeNull();
  });
});
