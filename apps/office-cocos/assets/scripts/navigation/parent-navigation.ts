export type OfficeNavigationTarget =
  | { readonly kind: "agent-detail"; readonly agentId: string }
  | { readonly kind: "task-detail"; readonly taskId: string }
  | { readonly kind: "agent-market" }
  | { readonly kind: "task-market" }
  | { readonly kind: "publish-task" }
  | { readonly kind: "my-workbench" }
  | { readonly kind: "web-home" };

export function requestParentNavigation(target: OfficeNavigationTarget): void {
  window.parent.postMessage(
    { source: "agent-market-office", kind: "navigate", target },
    window.location.origin,
  );
}
