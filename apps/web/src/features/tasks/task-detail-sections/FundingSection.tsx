import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatAmount } from "@agent-market/domain";
import { useSession } from "../../session/SessionProvider.js";
import { ApiError, getTask, type TaskRecord } from "../api.js";

export interface FundingSectionProps {
  taskId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; task: TaskRecord }
  | { status: "error"; message: string };

const SECTION_CLASSES = "mt-8 rounded-card border border-divider-light bg-surface-light p-6 md:p-8";

/**
 * Owns the DRAFT/AWAITING_FUNDING section only — minimal `{ taskId }` props
 * (design.md), fetching its own `TaskRecord` rather than having
 * `TaskDetailSections` pass one down, so Feature 7/8/9/10's own sections
 * don't have to agree on an ever-growing shared props shape.
 *
 * Does NOT reimplement the two-transaction (`approve` → `createTask`)
 * funding orchestration: that knowledge has exactly one owner,
 * `TaskCreatePage`'s `?taskId=` resume effect. This section only links there.
 */
export function FundingSection({ taskId }: FundingSectionProps) {
  const session = useSession();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    setState({ status: "loading" });
    getTask(taskId)
      .then((task) => {
        if (!ignore) setState({ status: "ready", task });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载资金锁定信息失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [taskId]);

  if (state.status === "loading") {
    return (
      <div className={SECTION_CLASSES}>
        <p className="text-body text-ink-secondary">加载中…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={SECTION_CLASSES}>
        <p role="alert" className="text-body text-warning">
          {state.message}
        </p>
      </div>
    );
  }

  const { task } = state;
  // Ownership must come from the AUTHENTICATED session address, never
  // `wallet.address` — the same identity-source lesson `MyPublishedTasksPage`
  // already documents (T-606 round 3): the wallet can report a different or
  // no-longer-authenticated address than the one the requester's session was
  // actually established for.
  const isOwner = session.status === "signed_in" && session.address === task.requesterAddress;

  return (
    <div className={SECTION_CLASSES}>
      <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">资金锁定</h2>
      <dl className="grid grid-cols-1 gap-3 text-caption sm:grid-cols-2">
        <div>
          <dt className="text-ink-secondary">标题</dt>
          <dd className="text-ink-primary">{task.title}</dd>
        </div>
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
      </dl>

      {isOwner ? (
        <div className="mt-6">
          <Link
            to={`/tasks/new?taskId=${taskId}`}
            className="inline-block rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90"
          >
            继续锁定资金
          </Link>
        </div>
      ) : (
        <p className="mt-6 text-body text-ink-secondary">该任务尚未开放招募。</p>
      )}
    </div>
  );
}
