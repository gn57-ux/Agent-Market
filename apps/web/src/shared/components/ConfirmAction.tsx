import { useState } from "react";

export interface ConfirmActionProps {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
}

// design.md's secondaryButton (light canvas): "transparent, blue label, no
// heavy border" for the initial (reversible-looking) action; the
// confirmation step uses the warning color since it's the point of actual
// commitment, and cancel stays a quiet text action.
const INITIAL_BUTTON_CLASSES =
  "rounded-control border border-divider-light px-4 py-1.5 text-caption font-medium text-action-blue transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50";
const CONFIRM_BUTTON_CLASSES =
  "rounded-control bg-warning px-4 py-1.5 text-caption font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const CANCEL_BUTTON_CLASSES = "px-3 py-1.5 text-caption text-ink-secondary hover:text-ink-primary";

/** A button that requires an explicit second click ("are you sure?") before
 * firing onConfirm — used for irreversible actions (e.g. dispute, dismiss,
 * Agent deactivation). */
export function ConfirmAction({
  label,
  confirmLabel = "确认？",
  onConfirm,
  disabled,
}: ConfirmActionProps) {
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  function handleConfirm() {
    // Reset (lock out further clicks) BEFORE invoking the callback, so a
    // double-click or a re-render while onConfirm is still running can't
    // re-invoke an irreversible action (duplicate dispute/transaction).
    setPendingConfirmation(false);
    onConfirm();
  }

  if (pendingConfirmation) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={disabled}
          className={CONFIRM_BUTTON_CLASSES}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setPendingConfirmation(false)}
          className={CANCEL_BUTTON_CLASSES}
        >
          取消
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPendingConfirmation(true)}
      disabled={disabled}
      className={INITIAL_BUTTON_CLASSES}
    >
      {label}
    </button>
  );
}
