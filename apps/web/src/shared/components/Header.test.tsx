import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Header } from "./Header.js";

describe("Header", () => {
  it("renders the wordmark and nav children", () => {
    render(
      <Header>
        <a href="/tasks">任务市场</a>
      </Header>,
    );
    expect(screen.getByText("Agent Market")).toBeTruthy();
    expect(screen.getByText("任务市场")).toBeTruthy();
  });
});
