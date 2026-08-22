import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FundingSection } from "./FundingSection.js";
import * as tasksApi from "../api.js";
import type { TaskRecord } from "../api.js";

const OWNER_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const OTHER_ADDRESS = "0x9876543210987654321098765432109876543210" as const;

let mockSessionStatus: "signed_out" | "signing_in" | "signed_in" | "error" = "signed_in";
let mockSessionAddress: `0x${string}` | undefined = OWNER_ADDRESS;

vi.mock("../../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: mockSessionStatus,
    address: mockSessionStatus === "signed_in" ? mockSessionAddress : undefined,
    errorMessage: undefined,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

function taskFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: OWNER_ADDRESS,
    category: "writing",
    title: "A draft task",
    description: "desc",
    budget: "1000000000000000000",
    token: `0x${"1".repeat(40)}` as const,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: [],
    status: "DRAFT",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderSection(taskId = "task-1") {
  return render(
    <MemoryRouter>
      <FundingSection taskId={taskId} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  mockSessionStatus = "signed_in";
  mockSessionAddress = OWNER_ADDRESS;
  vi.restoreAllMocks();
});

describe("FundingSection", () => {
  it("fetches the task itself given only a taskId", async () => {
    const getTaskSpy = vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    renderSection("task-1");
    await waitFor(() => expect(getTaskSpy).toHaveBeenCalledWith("task-1"));
  });

  it("renders draft info and a resume-funding link when the viewer is the owner (session.address, not wallet.address)", async () => {
    mockSessionAddress = OWNER_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ requesterAddress: OWNER_ADDRESS }),
    );
    renderSection();

    expect(await screen.findByText("A draft task")).toBeTruthy();
    const link = (await screen.findByText("继续锁定资金")).closest("a");
    expect(link?.getAttribute("href")).toBe("/tasks/new?taskId=task-1");
  });

  it("renders read-only info with no action controls when the viewer is not the owner", async () => {
    mockSessionAddress = OTHER_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ requesterAddress: OWNER_ADDRESS }),
    );
    renderSection();

    expect(await screen.findByText("该任务尚未开放招募。")).toBeTruthy();
    expect(screen.queryByText("继续锁定资金")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders read-only info with no action controls when the viewer is signed out", async () => {
    mockSessionStatus = "signed_out";
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ requesterAddress: OWNER_ADDRESS }),
    );
    renderSection();

    expect(await screen.findByText("该任务尚未开放招募。")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows an error message when the fetch fails", async () => {
    vi.spyOn(tasksApi, "getTask").mockRejectedValue(new Error("network down"));
    renderSection();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
