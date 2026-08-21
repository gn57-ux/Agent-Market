import { useState } from "react";

export interface ConfirmActionProps {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
}

/** A button that requires an explicit second click ("are you sure?") before
 * firing onConfirm — used for irreversible actions (e.g. dispute, dismiss). */
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
      <span>
        <button type="button" onClick={handleConfirm} disabled={disabled}>
          {confirmLabel}
        </button>
        <button type="button" onClick={() => setPendingConfirmation(false)}>
          取消
        </button>
      </span>
    );
  }

  return (
    <button type="button" onClick={() => setPendingConfirmation(true)} disabled={disabled}>
      {label}
    </button>
  );
}
