import { useEffect, useRef, type ReactNode } from "react";
import { useMediaQuery } from "./useMediaQuery.js";

export const DESKTOP_BREAKPOINT_QUERY = "(min-width: 768px)";

export interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  /** The business content component. It must not know or care whether it's
   * being rendered as a centered Dialog or a Bottom Sheet — same content,
   * same state, only the presentation differs. */
  content: ReactNode;
  titleForA11y: string;
}

/**
 * Always a single native <dialog> element — real modal semantics (focus
 * trap, Escape-to-close, ::backdrop, background inert) on both desktop and
 * mobile. Only `data-action-sheet-variant` (and CSS driven by it) changes
 * with viewport: "dialog" (centered) on desktop, "bottom-sheet" (anchored
 * to the bottom) on mobile. Using one element type for both means `content`
 * never gets unmounted/remounted when the viewport crosses the breakpoint
 * while open — its local state survives.
 */
export function ActionSheet({ open, onClose, content, titleForA11y }: ActionSheetProps) {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Use the `open` attribute (not the `.open` IDL property) as the source
    // of truth: some environments (jsdom in tests, older browsers) don't
    // implement HTMLDialogElement's showModal()/close()/`.open` reflection
    // at all, so relying on the property would silently desync.
    const isCurrentlyOpen = dialog.hasAttribute("open");
    if (open && !isCurrentlyOpen) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (!open && isCurrentlyOpen) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={titleForA11y}
      // The native <dialog> fires exactly one 'close' event for every way
      // it closes (Escape, our own .close() call, a <form method="dialog">
      // submit) — a single handler here is the one notification path.
      // Do NOT also bind 'cancel': Escape fires cancel-then-close, and
      // binding onClose to both would invoke it twice for one keypress.
      onClose={onClose}
      data-action-sheet-variant={isDesktop ? "dialog" : "bottom-sheet"}
    >
      {content}
    </dialog>
  );
}
