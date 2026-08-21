export type TaskStatus =
  | { kind: "DRAFT" }
  | { kind: "AWAITING_FUNDING" }
  | { kind: "OPEN" }
  | { kind: "ACCEPTED"; agent: `0x${string}` }
  | { kind: "SUBMITTED"; agent: `0x${string}`; submittedAt: string; reviewDeadline: string }
  | { kind: "DISPUTED"; agent: `0x${string}` }
  | { kind: "RELEASED" }
  | { kind: "REFUNDED" }
  | { kind: "CANCELLED" };

export type TaskStatusKind = TaskStatus["kind"];
