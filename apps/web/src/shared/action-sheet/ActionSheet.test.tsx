import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionSheet, DESKTOP_BREAKPOINT_QUERY } from "./ActionSheet.js";

/** jsdom has no real layout engine, so we mock matchMedia directly instead
 * of resizing anything. Real listeners are wired up (not no-ops) so that
 * `setIsDesktopNow` below can simulate an actual viewport crossing while a
 * component is mounted, the same way a real browser fires MediaQueryList's
 * 'change' event. */
let currentIsDesktop = true;
const changeListeners = new Set<() => void>();

function mockMatchMedia(isDesktopNow: boolean) {
  currentIsDesktop = isDesktopNow;
  changeListeners.clear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return query === DESKTOP_BREAKPOINT_QUERY ? currentIsDesktop : !currentIsDesktop;
    },
    media: query,
    addEventListener: (_event: string, listener: () => void) => {
      changeListeners.add(listener);
    },
    removeEventListener: (_event: string, listener: () => void) => {
      changeListeners.delete(listener);
    },
  }));
}

/** Simulates the viewport actually crossing the breakpoint while mounted. */
function setIsDesktopNow(isDesktopNow: boolean) {
  currentIsDesktop = isDesktopNow;
  for (const listener of changeListeners) listener();
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

  it("renders as data-action-sheet-variant='dialog' on desktop viewports", () => {
    mockMatchMedia(true);
    render(
      <ActionSheet
        open
        onClose={vi.fn()}
        titleForA11y="确认锁定预算"
        content={<BusinessContent onDone={vi.fn()} />}
      />,
    );

    expect(document.querySelector('[data-action-sheet-variant="dialog"]')).toBeTruthy();
    expect(document.querySelector('[data-action-sheet-variant="bottom-sheet"]')).toBeNull();
    expect(screen.getByText("确认将预算 100 YD 锁入托管合约？")).toBeTruthy();
  });

  it("renders as data-action-sheet-variant='bottom-sheet' on mobile viewports, using the same <dialog> element (real modal semantics, not a decorative div)", () => {
    mockMatchMedia(false);
    render(
      <ActionSheet
        open
        onClose={vi.fn()}
        titleForA11y="确认锁定预算"
        content={<BusinessContent onDone={vi.fn()} />}
      />,
    );

    const sheet = document.querySelector('[data-action-sheet-variant="bottom-sheet"]');
    expect(sheet).toBeTruthy();
    expect(sheet?.tagName.toLowerCase()).toBe("dialog");
    expect(document.querySelector('[data-action-sheet-variant="dialog"]')).toBeNull();
    expect(screen.getByText("确认将预算 100 YD 锁入托管合约？")).toBeTruthy();
  });

  it("the same content component behaves identically in both variants (button click fires the same callback)", () => {
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

  it("closed: the dialog element exists but has no [open] attribute, in both variants", () => {
    for (const isDesktopNow of [true, false]) {
      mockMatchMedia(isDesktopNow);
      const { unmount } = render(
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
      unmount();
    }
  });

  it("crossing the breakpoint while open does not remount content (local state survives)", () => {
    mockMatchMedia(true);
    let mountCount = 0;
    function StatefulContent() {
      // useState's initializer only runs once per mount; a remount would
      // increment this a second time. A plain render-count would also tick
      // on every re-render for unrelated reasons, so this is the more
      // precise signal for "did this component actually get torn down and
      // recreated".
      const [, setState] = useState(() => {
        mountCount += 1;
        return 0;
      });
      void setState;
      return <p>已挂载次数：{mountCount}</p>;
    }

    render(
      <ActionSheet
        open
        onClose={vi.fn()}
        titleForA11y="确认锁定预算"
        content={<StatefulContent />}
      />,
    );
    expect(document.querySelector('[data-action-sheet-variant="dialog"]')).toBeTruthy();
    expect(mountCount).toBe(1);

    // Cross the breakpoint (desktop -> mobile) while still open — simulates
    // a real MediaQueryList 'change' event, not just a prop/mock swap.
    act(() => {
      setIsDesktopNow(false);
    });

    expect(document.querySelector('[data-action-sheet-variant="bottom-sheet"]')).toBeTruthy();
    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    // If content had been unmounted and remounted, mountCount would be 2.
    expect(mountCount).toBe(1);
  });

  it("only registers one close notification path — dispatching 'close' calls onClose once, and there is no separate 'cancel' handler to double-fire it", () => {
    mockMatchMedia(true);
    const onClose = vi.fn();
    render(
      <ActionSheet
        open
        onClose={onClose}
        titleForA11y="确认锁定预算"
        content={<BusinessContent onDone={vi.fn()} />}
      />,
    );

    const dialog = document.querySelector("dialog");
    expect(dialog).toBeTruthy();

    // Real browsers fire 'cancel' then 'close' for an Escape keypress. If
    // this component bound onClose to both, this single simulated sequence
    // would call it twice. It only binds 'close'.
    dialog?.dispatchEvent(new Event("cancel"));
    dialog?.dispatchEvent(new Event("close"));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
