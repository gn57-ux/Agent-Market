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

  if (pendingConfirmation) {
    return (
      <span>
        <button type="button" onClick={onConfirm} disabled={disabled}>
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
