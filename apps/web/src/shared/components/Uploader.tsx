import type { ChangeEvent } from "react";

export interface UploaderProps {
  onFileSelected: (file: File) => void;
  accept?: string;
  disabled?: boolean;
}

/** Deliberately thin: just wires the native file input to a callback.
 * File type/size validation and upload logic belong to the consumer
 * (Feature 9's deliverables module owns those rules). */
export function Uploader({ onFileSelected, accept, disabled }: UploaderProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      onFileSelected(file);
    }
  }

  return (
    <input
      type="file"
      accept={accept}
      disabled={disabled}
      onChange={handleChange}
      aria-label="上传成果文件"
    />
  );
}
