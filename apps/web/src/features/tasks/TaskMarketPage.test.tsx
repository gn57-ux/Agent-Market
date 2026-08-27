import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskMarketPage } from "./TaskMarketPage.js";
import * as tasksApi from "./api.js";
import type { TaskRecord } from "./api.js";

function taskFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: "0x1234567890123456789012345678901234567890",
    category: "writing",
    title: "Public market task",
    description: "desc",
    budget: "1000000000000000000",
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

function renderPage() {
  return render(
    <MemoryRouter>
      <TaskMarketPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TaskMarketPage", () => {
  it("loads the public market without a requester param, and without requiring a wallet/session (F-610, public market semantics)", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenCalledWith({
        category: undefined,
        skillTag: undefined,
        status: undefined,
        page: 1,
      }),
    );
    // Never pass a `requester` key at all — passing one, even `undefined`
    // explicitly as a key, would still be the wrong shape to assert against;
    // what actually matters is the call above has no `requester` property.
    const callArgs = listTasksSpy.mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty("requester");
    expect(await screen.findByText("Public market task")).toBeTruthy();
  });

  it("shows a loading state before the first response resolves", () => {
    vi.spyOn(tasksApi, "listTasks").mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("加载中…")).toBeTruthy();
  });

  it("shows an empty-state message when no tasks match", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    renderPage();
    expect(await screen.findByText("暂无符合条件的任务。")).toBeTruthy();
  });

  it("keeps pagination visible (with a way back to page 1) when the current page's items are empty but total is nonzero (Codex round 1 P2)", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [],
      total: 5,
      page: 2,
      pageSize: 20,
    });
    renderPage();

    expect(await screen.findByText("暂无符合条件的任务。")).toBeTruthy();
    const prevButton = screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    expect(prevButton.disabled).toBe(false);
    expect(screen.getByText("第 2 页 / 共 5 条")).toBeTruthy();
  });

  it("shows an error message when the request fails", async () => {
    vi.spyOn(tasksApi, "listTasks").mockRejectedValue(new Error("network down"));
    renderPage();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("re-queries with category and skillTag filters on submit, resetting to page 1", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();
    await screen.findByText("Public market task");

    // The initial mount fires exactly one query (no filters). Typing alone —
    // before the submit button is clicked — must NOT fire another one; if it
    // did, the query would run with a half-typed value and the "筛选" button
    // would be decorative (Codex round 1, P2).
    const callsBeforeTyping = listTasksSpy.mock.calls.length;
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("技能标签"), { target: { value: "solidity" } });
    expect(listTasksSpy.mock.calls.length).toBe(callsBeforeTyping);

    fireEvent.click(screen.getByRole("button", { name: "筛选" }));

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({
        category: "writing",
        skillTag: "solidity",
        status: undefined,
        page: 1,
      }),
    );
    expect(listTasksSpy.mock.calls.length).toBe(callsBeforeTyping + 1);
  });

  it("queries with the selected status filter, restricted to OPEN-and-later statuses (AC-607)", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture({ status: "ACCEPTED" })],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();
    await screen.findByText("Public market task");

    fireEvent.click(screen.getByRole("button", { name: "已接单" }));

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({
        category: undefined,
        skillTag: undefined,
        status: "ACCEPTED",
        page: 1,
      }),
    );

    // DRAFT/AWAITING_FUNDING must not even be offered as filter choices —
    // the backend already excludes them from the public market, so surfacing
    // them here would only ever produce a silently-empty result.
    expect(screen.queryByRole("button", { name: "草稿" })).toBeNull();
    expect(screen.queryByRole("button", { name: "等待资金确认" })).toBeNull();
  });

  it("paginates forward and back using page/pageSize state, mirroring AgentMarketPage's pattern", async () => {
    const listTasksSpy = vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture()],
      total: 40,
      page: 1,
      pageSize: 20,
    });

    renderPage();
    await screen.findByText("Public market task");

    expect(screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    await waitFor(() =>
      expect(listTasksSpy).toHaveBeenLastCalledWith({
        category: undefined,
        skillTag: undefined,
        status: undefined,
        page: 2,
      }),
    );
  });

  it("links a task card to its detail route now that /tasks/:taskId exists (T-608, same as MyPublishedTasksPage)", async () => {
    vi.spyOn(tasksApi, "listTasks").mockResolvedValue({
      items: [taskFixture()],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderPage();
    await screen.findByText("Public market task");

    const card = document.querySelector('[data-task-id="task-1"]');
    expect(card).toBeTruthy();
    const link = card?.closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/tasks/task-1");
  });
});
