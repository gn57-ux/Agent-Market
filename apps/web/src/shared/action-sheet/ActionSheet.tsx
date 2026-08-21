import { useEffect, useRef, type ReactNode } from "react";
import { useMediaQuery } from "./useMediaQuery.js";

export const DESKTOP_BREAKPOINT_QUERY = "(min-width: 768px)";

export interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  /** The business content component. It must not know or care whether it's
   * being rendered inside a Dialog or a Bottom Sheet — same content, same
   * state, only the surrounding container differs. */
  content: ReactNode;
  titleForA11y: string;
}

/**
 * Desktop (>= DESKTOP_BREAKPOINT_QUERY): renders `content` inside a native
 * <dialog> (real modal semantics: focus trap, Escape-to-close, backdrop).
 * Mobile: renders the identical `content` inside a bottom-anchored panel.
 */
export function ActionSheet({ open, onClose, content, titleForA11y }: ActionSheetProps) {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!isDesktop) return;
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
  }, [open, isDesktop]);

  if (isDesktop) {
    return (
      <dialog
        ref={dialogRef}
        aria-label={titleForA11y}
        onClose={onClose}
        onCancel={onClose}
        data-action-sheet-variant="dialog"
      >
        {content}
      </dialog>
    );
  }

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={titleForA11y}
      data-action-sheet-variant="bottom-sheet"
    >
      {content}
    </div>
  );
}
