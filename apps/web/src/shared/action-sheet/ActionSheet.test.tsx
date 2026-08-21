import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionSheet, DESKTOP_BREAKPOINT_QUERY } from "./ActionSheet.js";

/** jsdom has no real layout engine, so we mock matchMedia directly instead
 * of resizing anything — `isDesktopNow` decides which query matches. */
function mockMatchMedia(isDesktopNow: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === DESKTOP_BREAKPOINT_QUERY ? isDesktopNow : !isDesktopNow,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function BusinessContent({ onDone }: { onDone: () => void }) {
  return (
    <div>
      <p>确认将预算 100 YD 锁入托管合约？</p>
      <button type="button" onClick={onDone}>
        确认
      </button>
    </div>
  );
}

describe("ActionSheet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders as a native <dialog> on desktop viewports", () => {
    mockMatchMedia(true);
    const onDone = vi.fn();
    render(
      <ActionSheet
        open
        onClose={vi.fn()}
        titleForA11y="确认锁定预算"
        content={<BusinessContent onDone={onDone} />}
      />,
    );

    expect(document.querySelector('[data-action-sheet-variant="dialog"]')).toBeTruthy();
    expect(document.querySelector('[data-action-sheet-variant="bottom-sheet"]')).toBeNull();
    expect(screen.getByText("确认将预算 100 YD 锁入托管合约？")).toBeTruthy();
  });

  it("renders as a bottom sheet on mobile viewports, with the identical content", () => {
    mockMatchMedia(false);
    const onDone = vi.fn();
    render(
      <ActionSheet
        open
        onClose={vi.fn()}
        titleForA11y="确认锁定预算"
        content={<BusinessContent onDone={onDone} />}
      />,
    );

    expect(document.querySelector('[data-action-sheet-variant="bottom-sheet"]')).toBeTruthy();
    expect(document.querySelector('[data-action-sheet-variant="dialog"]')).toBeNull();
    expect(screen.getByText("确认将预算 100 YD 锁入托管合约？")).toBeTruthy();
  });

  it("the same content component behaves identically in both containers (button click fires the same callback)", () => {
    for (const isDesktopNow of [true, false]) {
      mockMatchMedia(isDesktopNow);
      const onDone = vi.fn();
      const { unmount } = render(
        <ActionSheet
          open
          onClose={vi.fn()}
          titleForA11y="确认锁定预算"
          content={<BusinessContent onDone={onDone} />}
        />,
      );

      fireEvent.click(screen.getByText("确认"));
      expect(onDone).toHaveBeenCalledOnce();
      unmount();
    }
  });

  it("mobile: renders nothing when closed", () => {
    mockMatchMedia(false);
    render(
      <ActionSheet
        open={false}
        onClose={vi.fn()}
        titleForA11y="确认锁定预算"
        content={<BusinessContent onDone={vi.fn()} />}
      />,
    );
    expect(document.querySelector('[data-action-sheet-variant="bottom-sheet"]')).toBeNull();
  });

  it("desktop: the dialog element exists but is not open when `open` is false", () => {
    mockMatchMedia(true);
    render(
      <ActionSheet
        open={false}
        onClose={vi.fn()}
        titleForA11y="确认锁定预算"
        content={<BusinessContent onDone={vi.fn()} />}
      />,
    );
    const dialog = document.querySelector("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog?.hasAttribute("open")).toBe(false);
  });
});
