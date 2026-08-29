import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Header } from "./Header.js";

describe("Header", () => {
  it("renders the wordmark and nav links", () => {
    render(<Header navLinks={<a href="/tasks">任务市场</a>} />);
    expect(screen.getByText("Agent Market")).toBeTruthy();
    expect(screen.getByText("任务市场")).toBeTruthy();
  });

  it("renders walletControls inline on both the desktop and mobile rows, never behind the mobile menu toggle", () => {
    render(
      <Header
        navLinks={<a href="/tasks">任务市场</a>}
        walletControls={<button type="button">连接钱包</button>}
      />,
    );
    // Two instances by design (desktop-inline row + always-visible mobile
    // row) — see Header.tsx's own doc comment for why a single shared node
    // can't occupy both positions at once.
    expect(screen.getAllByRole("button", { name: "连接钱包" })).toHaveLength(2);
  });

  it("lets the header row grow instead of clipping when walletControls needs two lines (Task E review: wallet+session capsule overlapped the hero)", () => {
    render(
      <Header
        navLinks={<a href="/tasks">任务市场</a>}
        walletControls={<button type="button">连接钱包</button>}
      />,
    );
    const row = screen.getByText("Agent Market").parentElement;
    expect(row?.className).toContain("min-h-[52px]");
    // A fixed height would clip a wrapped second line (from
    // walletControls' own `flex-wrap` capsule) to overflow past the
    // header's bottom edge instead of the header growing to fit it.
    expect(row?.className).not.toMatch(/(?<!min-)h-\[52px\]/);
  });

  it("collapses nav links behind a toggle that is closed by default and opens on click", () => {
    render(<Header navLinks={<a href="/tasks">任务市场</a>} />);
    const toggle = screen.getByRole("button", { name: "打开导航菜单" });
    expect(screen.getAllByText("任务市场")).toHaveLength(1);

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "关闭导航菜单" })).toBeTruthy();
    // Now present in both the (CSS-hidden-on-mobile) desktop row and the
    // opened mobile dropdown.
    expect(screen.getAllByText("任务市场")).toHaveLength(2);
  });
});
