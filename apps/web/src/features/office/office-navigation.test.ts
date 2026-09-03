import { describe, expect, it } from "vitest";
import { officeTargetPath, readOfficeNavigationMessage } from "./office-navigation.js";

describe("office navigation boundary", () => {
  it("accepts a typed task navigation message", () => {
    const target = readOfficeNavigationMessage({
      source: "agent-market-office",
      kind: "navigate",
      target: { kind: "task-detail", taskId: "task/a" },
    });
    expect(target).toEqual({ kind: "task-detail", taskId: "task/a" });
    if (target) expect(officeTargetPath(target)).toBe("/tasks/task%2Fa");
  });
  it("rejects messages from an unknown protocol", () => {
    expect(
      readOfficeNavigationMessage({
        source: "other",
        kind: "navigate",
        target: { kind: "web-home" },
      }),
    ).toBeNull();
  });
});
