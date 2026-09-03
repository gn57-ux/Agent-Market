export type OfficeNavigationTarget =
  | { readonly kind: "agent-detail"; readonly agentId: string }
  | { readonly kind: "task-detail"; readonly taskId: string }
  | { readonly kind: "agent-market" }
  | { readonly kind: "task-market" }
  | { readonly kind: "publish-task" }
  | { readonly kind: "my-workbench" }
  | { readonly kind: "web-home" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readOfficeNavigationMessage(value: unknown): OfficeNavigationTarget | null {
  if (
    !isRecord(value) ||
    value.source !== "agent-market-office" ||
    value.kind !== "navigate" ||
    !isRecord(value.target)
  )
    return null;
  const target = value.target;
  if (target.kind === "agent-detail" && typeof target.agentId === "string")
    return { kind: "agent-detail", agentId: target.agentId };
  if (target.kind === "task-detail" && typeof target.taskId === "string")
    return { kind: "task-detail", taskId: target.taskId };
  if (
    ["agent-market", "task-market", "publish-task", "my-workbench", "web-home"].includes(
      String(target.kind),
    )
  ) {
    if (
      target.kind === "agent-market" ||
      target.kind === "task-market" ||
      target.kind === "publish-task" ||
      target.kind === "my-workbench" ||
      target.kind === "web-home"
    )
      return { kind: target.kind };
  }
  return null;
}

export function officeTargetPath(target: OfficeNavigationTarget): string {
  switch (target.kind) {
    case "agent-detail":
      return `/agents/${encodeURIComponent(target.agentId)}`;
    case "task-detail":
      return `/tasks/${encodeURIComponent(target.taskId)}`;
    case "agent-market":
      return "/agents";
    case "task-market":
      return "/tasks";
    case "publish-task":
      return "/tasks/new";
    case "my-workbench":
      return "/tasks/accepted";
    case "web-home":
      return "/";
  }
}
