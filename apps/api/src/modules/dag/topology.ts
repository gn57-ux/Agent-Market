/**
 * Feature 17 (multi-agent-dag-orchestration), T-1701.
 *
 * Pure topology validation for a DAG creation request — no I/O, no
 * database, deliberately separate from schema.ts (structural shape) and
 * repository.ts (persistence): this is the one place F-1701's "无环、汇总
 * 节点前置存在" rules are computed, independently unit-testable without a
 * database (matches CLAUDE.md's "复杂性必须下沉到合适的模块" and design.md's
 * non-functional requirement that DAG orchestration logic be testable
 * independent of any executor).
 */

export interface TopologyNodeInput {
  key: string;
  role: "SERIAL" | "PARALLEL" | "AGGREGATE";
  dependsOn: string[];
}

export type TopologyValidationResult =
  | { ok: true }
  | { ok: false; reason: "DUPLICATE_KEY"; detail: string }
  | { ok: false; reason: "DANGLING_DEPENDENCY"; detail: string }
  | { ok: false; reason: "CYCLE"; detail: string }
  | { ok: false; reason: "AGGREGATE_WITHOUT_PRECONDITION"; detail: string };

/**
 * Validates F-1701/F-1702's structural requirements against a DAG creation
 * request's node set, using each node's own client-supplied `key` (not yet
 * a real UUID — those don't exist until repository.ts persists the DAG) as
 * the graph's vertex identity.
 *
 * Order of checks matters for error usefulness: a dangling reference or
 * duplicate key makes cycle detection's output meaningless (it would be
 * reasoning about a malformed graph), so those are checked first.
 */
export function validateTopology(nodes: TopologyNodeInput[]): TopologyValidationResult {
  const keys = new Set<string>();
  for (const node of nodes) {
    if (keys.has(node.key)) {
      return { ok: false, reason: "DUPLICATE_KEY", detail: `重复的节点 key："${node.key}"` };
    }
    keys.add(node.key);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!keys.has(dep)) {
        return {
          ok: false,
          reason: "DANGLING_DEPENDENCY",
          detail: `节点 "${node.key}" 依赖了不存在的节点 "${dep}"`,
        };
      }
    }
  }

  // Kahn's algorithm: repeatedly remove nodes with in-degree 0. A DAG is
  // acyclic iff every node can eventually be removed this way; any nodes
  // left over after the queue is exhausted are part of (or downstream of) a
  // cycle — includes a 1-node self-loop, since a node depending on itself
  // never reaches in-degree 0.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.key, node.dependsOn.length);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(node.key);
      dependents.set(dep, list);
    }
  }

  const queue: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key);
  }
  let processedCount = 0;
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined) break;
    processedCount += 1;
    for (const dependentKey of dependents.get(key) ?? []) {
      const remaining = (inDegree.get(dependentKey) ?? 0) - 1;
      inDegree.set(dependentKey, remaining);
      if (remaining === 0) queue.push(dependentKey);
    }
  }
  if (processedCount !== nodes.length) {
    const cyclicKeys = [...inDegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([key]) => key);
    return {
      ok: false,
      reason: "CYCLE",
      detail: `检测到环，涉及节点：${cyclicKeys.join(", ")}`,
    };
  }

  // F-1702: an AGGREGATE node's entire purpose is to wait for multiple
  // preceding nodes — one with zero declared preconditions is not a real
  // aggregation point, just a mislabeled entry node.
  for (const node of nodes) {
    if (node.role === "AGGREGATE" && node.dependsOn.length === 0) {
      return {
        ok: false,
        reason: "AGGREGATE_WITHOUT_PRECONDITION",
        detail: `汇总节点 "${node.key}" 没有声明任何前置节点`,
      };
    }
  }

  return { ok: true };
}
