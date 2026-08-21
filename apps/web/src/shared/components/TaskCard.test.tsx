import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskCard } from "./TaskCard.js";

describe("TaskCard", () => {
  it("renders title, formatted budget, and status", () => {
    render(
      <TaskCard
        taskId="task-1"
        title="剪辑一支短视频"
        budgetDisplay="100 YD"
        status={{ kind: "OPEN" }}
      />,
    );
    expect(screen.getByText("剪辑一支短视频")).toBeTruthy();
    expect(screen.getByText("100 YD")).toBeTruthy();
    expect(screen.getByText("招募中")).toBeTruthy();
  });
});
