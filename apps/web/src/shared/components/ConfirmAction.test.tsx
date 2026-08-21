import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmAction } from "./ConfirmAction.js";

describe("ConfirmAction", () => {
  it("does not call onConfirm on the first click; requires a second explicit confirmation", () => {
    const onConfirm = vi.fn();
    render(<ConfirmAction label="发起争议" confirmLabel="确定发起？" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText("发起争议"));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("确定发起？"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("resets to the initial label after confirming, so a rapid second click doesn't re-invoke onConfirm", () => {
    const onConfirm = vi.fn();
    render(<ConfirmAction label="发起争议" confirmLabel="确定发起？" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText("发起争议"));
    const confirmButton = screen.getByText("确定发起？");
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledOnce();

    // Back to the initial label; the old confirm button is gone, so a second
    // click on it (simulating a double-click racing the reset) hits nothing.
    expect(screen.queryByText("确定发起？")).toBeNull();
    expect(screen.getByText("发起争议")).toBeTruthy();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cancel returns to the initial label without calling onConfirm", () => {
    const onConfirm = vi.fn();
    render(<ConfirmAction label="发起争议" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText("发起争议"));
    fireEvent.click(screen.getByText("取消"));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("发起争议")).toBeTruthy();
  });
});
