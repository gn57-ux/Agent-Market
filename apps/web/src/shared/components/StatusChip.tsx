export type StatusChipTone = "neutral" | "success" | "warning" | "info";

export interface StatusChipProps {
  label: string;
  tone?: StatusChipTone;
}

const DOT_CLASSES: Record<StatusChipTone, string> = {
  neutral: "bg-ink-secondary",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-action-blue",
};

const TEXT_CLASSES: Record<StatusChipTone, string> = {
  neutral: "text-ink-secondary",
  success: "text-success",
  warning: "text-warning",
  info: "text-action-blue",
};

/**
 * design.md's `statusChip` component: "compact pill; use color only as a
 * secondary signal together with text or icon" — never color alone, always
 * a dot + label. Purely presentational (no domain knowledge of what a
 * status MEANS) so it's shared by StatusBadge (Task status, Feature 6-10)
 * and Feature 5's Agent ACTIVE/INACTIVE chip, without coupling those two
 * domains' status vocabularies together.
 */
export function StatusChip({ label, tone = "neutral" }: StatusChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-control border border-divider-light px-2.5 py-1 text-caption ${TEXT_CLASSES[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} />
      {label}
    </span>
  );
}
