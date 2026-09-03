import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TaskDetailPage } from "./TaskDetailPage.js";
import * as tasksApi from "./api.js";
import type { TaskRecord } from "./api.js";

vi.mock("./TaskDetailSections.js", () => ({
  TaskDetailSections: ({ onTaskChanged }: { onTaskChanged?: () => void }) => (
    <button type="button" onClick={onTaskChanged}>
      模拟接单成功
    </button>
  ),
}));

function taskFixture(status: TaskRecord["status"]): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: "0x1234567890123456789012345678901234567890",
    category: "writing",
    title: "状态刷新测试",
    description: "desc",
    budget: "1000000000000000000",
    token: `0x${"1".repeat(40)}` as const,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: [],
    expertType: "AUTOMATION",
    status,
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acceptedAgentAddress:
      status === "ACCEPTED" ? "0x9999999999999999999999999999999999999999" : null,
    acceptedAt: status === "ACCEPTED" ? "2026-01-01T01:00:00.000Z" : null,
  };
}

describe("TaskDetailPage status refresh", () => {
  it("reloads the authoritative task after a child action changes its status", async () => {
    const getTaskSpy = vi
      .spyOn(tasksApi, "getTask")
      .mockResolvedValueOnce(taskFixture("OPEN"))
      .mockResolvedValueOnce(taskFixture("ACCEPTED"));

    render(
      <MemoryRouter initialEntries={["/tasks/task-1"]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("招募中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "模拟接单成功" }));

    expect(await screen.findByText("已接单")).toBeTruthy();
    await waitFor(() => expect(getTaskSpy).toHaveBeenCalledTimes(2));
  });
});
