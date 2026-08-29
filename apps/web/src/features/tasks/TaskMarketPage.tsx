import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { HexAddress } from "@agent-market/domain";
import { formatAmount } from "@agent-market/domain";
import { TaskCard } from "../../shared/components/TaskCard.js";
import { ApiError, listTasks, type TaskRecord, type TaskStatusValue } from "./api.js";
import { toTaskStatus } from "./MyPublishedTasksPage.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; items: TaskRecord[]; total: number; page: number; pageSize: number }
  | { status: "error"; message: string };

/** "ALL" is a client-side concept only — it means "omit the status query
 * param entirely," mirroring `AgentMarketPage`'s identical `StatusFilter`
 * convention (T-505). Options are deliberately restricted to `OPEN` and the
 * statuses that follow it: AC-607 scopes the public market to "`OPEN` 及以后
 * 状态" and design.md's interface contract says the backend (T-605) already
 * excludes `DRAFT`/`AWAITING_FUNDING` when `requester` is omitted — offering
 * those two as filter choices here would only ever produce an empty result,
 * so they're not in this list at all rather than silently filtered client
 * side. */
type MarketStatusFilter = Exclude<TaskStatusValue, "DRAFT" | "AWAITING_FUNDING"> | "ALL";

const INPUT_CLASSES =
  "w-full rounded-input border border-divider-light bg-canvas-light px-4 py-2.5 text-body text-ink-primary placeholder:text-ink-secondary focus:border-action-blue focus:outline-none focus:ring-2 focus:ring-action-blue/20 sm:w-48";

const STATUS_FILTER_OPTIONS: { value: MarketStatusFilter; label: string }[] = [
  { value: "ALL", label: "全部" },
  { value: "OPEN", label: "招募中" },
  { value: "ACCEPTED", label: "已接单" },
  { value: "SUBMITTED", label: "待验收" },
  { value: "DISPUTED", label: "争议中" },
  { value: "RELEASED", label: "已放款" },
  { value: "REFUNDED", label: "已退款" },
  { value: "CANCELLED", label: "已取消" },
];

/**
 * F-610 / AC-607: the public task market — browsable without a connected
 * wallet or a signed-in session (design.md, same public-market semantics as
 * `AgentMarketPage`). Deliberately queries `GET /tasks` WITHOUT a `requester`
 * param: passing one flips the query into the "我的发布" identity context
 * that `MyPublishedTasksPage` owns (T-605/T-606 lesson — a filter param must
 * come from the identity it actually represents, and this page represents no
 * identity at all, just the public market). The `OPEN`-and-later restriction
 * itself is NOT re-implemented here: T-605's `listTasksForMarket` already
 * enforces it server-side whenever `requester` is absent, so this component
 * only forwards whatever status/category/skillTag the visitor picks.
 */
export function TaskMarketPage() {
  // Two-tier state, deliberately NOT collapsed into one (Codex review,
  // T-607 round 1, P2): `categoryInput`/`skillTagInput` are the raw,
  // every-keystroke value the text fields are bound to; `category`/
  // `skillTag` are the APPLIED values the query effect actually depends on.
  // Without this split, the effect fires on every keystroke (both are
  // effect dependencies), making the "筛选" submit button decorative — the
  // query already ran with a half-typed value before the user finished
  // typing or clicked anything.
  const [categoryInput, setCategoryInput] = useState("");
  const [skillTagInput, setSkillTagInput] = useState("");
  const [category, setCategory] = useState("");
  const [skillTag, setSkillTag] = useState("");
  const [statusFilter, setStatusFilter] = useState<MarketStatusFilter>("ALL");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    setState({ status: "loading" });
    listTasks({
      category: category || undefined,
      skillTag: skillTag || undefined,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      page,
    })
      .then((result) => {
        if (ignore) return;
        setState({ status: "ready", ...result });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载任务市场失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [category, skillTag, statusFilter, page]);

  function handleStatusFilterChange(next: MarketStatusFilter) {
    setStatusFilter(next);
    setPage(1);
  }

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCategory(categoryInput);
    setSkillTag(skillTagInput);
    setPage(1);
  }

  return (
    <section className="mx-auto max-w-content px-gutter-mobile pb-section-mobile pt-10 md:px-gutter-desktop md:pb-section-desktop md:pt-16">
      <header className="mb-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
        <div className="max-w-reading">
          <h1 className="text-display-mobile text-ink-primary md:text-display">
            发现适合你的 AI 任务
          </h1>
          <p className="mt-3 text-lead text-ink-secondary">
            浏览任务需求、预算与技能要求，找到适合你的下一项协作。
          </p>
        </div>
        <Link
          to="/tasks/new"
          className="whitespace-nowrap rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90"
        >
          发布任务
        </Link>
      </header>

      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="按状态筛选">
        {STATUS_FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={statusFilter === option.value}
            onClick={() => handleStatusFilterChange(option.value)}
            className={
              statusFilter === option.value
                ? "rounded-control bg-ink-primary px-4 py-1.5 text-caption font-medium text-white"
                : "rounded-control border border-divider-light px-4 py-1.5 text-caption text-ink-secondary transition-colors hover:bg-canvas-warm"
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={handleFilterSubmit}
        className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center"
      >
        <label className="flex flex-col gap-1.5 text-caption text-ink-secondary sm:flex-row sm:items-center sm:gap-3">
          分类
          <input
            value={categoryInput}
            onChange={(event) => setCategoryInput(event.target.value)}
            className={INPUT_CLASSES}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-caption text-ink-secondary sm:flex-row sm:items-center sm:gap-3">
          技能标签
          <input
            value={skillTagInput}
            onChange={(event) => setSkillTagInput(event.target.value)}
            className={INPUT_CLASSES}
          />
        </label>
        <button
          type="submit"
          className="rounded-control border border-divider-light px-5 py-2.5 text-caption font-medium text-ink-primary transition-colors hover:bg-canvas-warm sm:self-start"
        >
          筛选
        </button>
      </form>

      {state.status === "loading" && <p className="text-body text-ink-secondary">加载中…</p>}
      {state.status === "error" && (
        <p role="alert" className="text-body text-warning">
          {state.message}
        </p>
      )}
      {state.status === "ready" && (
        <>
          {state.items.length === 0 ? (
            <p className="py-16 text-center text-body text-ink-secondary">暂无符合条件的任务。</p>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {state.items.map((task) => (
                <Link key={task.taskId} to={`/tasks/${task.taskId}`}>
                  <TaskCard
                    taskId={task.taskId}
                    title={task.title}
                    description={task.description}
                    category={task.category}
                    skillTags={task.skillTags}
                    deliveryDeadline={task.deliveryDeadline}
                    requesterAddress={task.requesterAddress}
                    budgetDisplay={`${formatAmount(BigInt(task.budget))} YD`}
                    status={toTaskStatus(task, task.acceptedAgentAddress as HexAddress | null)}
                  />
                </Link>
              ))}
            </div>
          )}
          {state.total > 0 && (
            // Keyed on `total`, not `items.length` (Codex review, T-608
            // round 1, P2): a filtered result set can go empty on page 2+
            // (e.g. matching tasks moved past this status filter between
            // requests) while `total` stays nonzero — hiding pagination in
            // that case would strand the viewer on a false empty state with
            // no way back to page 1.
            <div className="mt-10 flex items-center justify-center gap-4 text-caption text-ink-secondary">
              <button
                type="button"
                disabled={state.page <= 1}
                onClick={() => setPage(page - 1)}
                className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
              >
                上一页
              </button>
              <span>
                第 {state.page} 页 / 共 {state.total} 条
              </span>
              <button
                type="button"
                disabled={state.page * state.pageSize >= state.total}
                onClick={() => setPage(page + 1)}
                className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
