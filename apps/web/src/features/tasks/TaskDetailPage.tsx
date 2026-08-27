import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { HexAddress } from "@agent-market/domain";
import { formatAmount } from "@agent-market/domain";
import { StatusBadge } from "../../shared/components/StatusBadge.js";
import { ApiError, getTask, type TaskRecord } from "./api.js";
import { toTaskStatus } from "./MyPublishedTasksPage.js";
import { TaskDetailSections } from "./TaskDetailSections.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; task: TaskRecord }
  | { status: "not_found" }
  | { status: "error"; message: string };

const PAGE_WRAP_CLASSES = "mx-auto max-w-content px-gutter-mobile py-16 md:px-gutter-desktop";

/**
 * `/tasks/:taskId` — the single detail route (design.md 方案 C). Visibility
 * for private DRAFT/AWAITING_FUNDING tasks is entirely the backend's job
 * (`getTaskDetail`, T-605): a non-owner or unauthenticated request for one
 * simply gets a 404, indistinguishable here from "task doesn't exist" — this
 * page does not re-derive who is allowed to see what.
 */
export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!taskId) return;
    let ignore = false;
    setState({ status: "loading" });
    getTask(taskId)
      .then((task) => {
        if (!ignore) setState({ status: "ready", task });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: "not_found" });
          return;
        }
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载任务详情失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [taskId]);

  if (state.status === "loading") {
    return (
      <div className={PAGE_WRAP_CLASSES}>
        <p className="text-body text-ink-secondary">加载中…</p>
      </div>
    );
  }
  if (state.status === "not_found") {
    return (
      <div className={PAGE_WRAP_CLASSES}>
        <p className="text-body text-ink-secondary">未找到该任务。</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={PAGE_WRAP_CLASSES}>
        <p role="alert" className="text-body text-warning">
          {state.message}
        </p>
      </div>
    );
  }

  const { task } = state;
  // `GET /tasks/:taskId` now serializes `acceptedAgentAddress` (T-805) —
  // see MyPublishedTasksPage.tsx's `toTaskStatus` doc comment for the
  // CHECK-constraint-backed cast reasoning.
  const status = toTaskStatus(task, task.acceptedAgentAddress as HexAddress | null);

  return (
    <section className={PAGE_WRAP_CLASSES}>
      <div className="mb-8 rounded-card border border-divider-light bg-surface-light p-8">
        <div className="mb-4">
          <StatusBadge status={status} />
        </div>
        <h1 className="mb-4 text-title text-ink-primary">{task.title}</h1>
        <p className="mb-6 max-w-reading text-body text-ink-secondary">{task.description}</p>
        <dl className="grid grid-cols-1 gap-3 text-caption sm:grid-cols-2">
          <div>
            <dt className="text-ink-secondary">分类</dt>
            <dd className="text-ink-primary">{task.category}</dd>
          </div>
          <div>
            <dt className="text-ink-secondary">预算</dt>
            <dd className="text-ink-primary">{formatAmount(BigInt(task.budget))} YD</dd>
          </div>
          <div>
            <dt className="text-ink-secondary">截止时间</dt>
            <dd className="text-ink-primary">{new Date(task.deliveryDeadline).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-ink-secondary">技能标签</dt>
            <dd className="text-ink-primary">
              {task.skillTags.length > 0 ? task.skillTags.join("、") : "无标签"}
            </dd>
          </div>
        </dl>
      </div>

      <TaskDetailSections status={status} taskId={task.taskId} />
    </section>
  );
}
