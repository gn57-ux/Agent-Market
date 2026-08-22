import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { StatusChip } from "../../shared/components/index.js";
import { QualityScoreLabel } from "./QualityScoreLabel.js";
import { listAgents, type Agent, type AgentStatus } from "./api.js";
import { ApiError } from "../../shared/api/client.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; items: Agent[]; total: number; page: number; pageSize: number }
  | { status: "error"; message: string };

/** "ALL" is a client-side concept only — it means "omit the status query
 * param entirely," matching apps/api's own default-unfiltered behavior
 * (schema.ts's listAgentsQuerySchema). No new backend capability: this
 * reuses GET /agents's existing status filter exactly as T-504 built it. */
type StatusFilter = AgentStatus | "ALL";

const INPUT_CLASSES =
  "w-full rounded-input border border-divider-light bg-canvas-light px-4 py-2.5 text-body text-ink-primary placeholder:text-ink-secondary focus:border-action-blue focus:outline-none focus:ring-2 focus:ring-action-blue/20 sm:w-48";

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "ACTIVE", label: "启用中" },
  { value: "INACTIVE", label: "已停用" },
  { value: "ALL", label: "全部" },
];

/**
 * design.md: "Agent Market: portrait-free capability cards focused on
 * category, skills, completion rate, quality and newcomer status." —
 * newcomer status is deliberately NOT shown here: it's Feature 7's
 * candidate-snapshot concern (requirements.md's "已确认决定": "新人定义...由
 * Feature 7 在计算候选快照时应用；本 Feature 只需保存 completedTaskCount 等原始字段"),
 * not something this listing computes or displays.
 *
 * Status filter defaults to ACTIVE (real browser walkthrough, T-505 P1:
 * reachability): without a way to view INACTIVE Agents from this page, a
 * deactivated Agent had no normal-navigation path back to its own detail
 * page to be reactivated — browser back/forward or a hand-typed URL isn't
 * a real product flow. "已停用"/"全部" reuse the exact same GET /agents
 * status filter T-504 already built; no new endpoint, no separate "my
 * Agents" management module.
 */
export function AgentMarketPage() {
  const [category, setCategory] = useState("");
  const [skillTag, setSkillTag] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ACTIVE");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    setState({ status: "loading" });
    listAgents({
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
          message: error instanceof ApiError ? error.message : "加载 Agent 列表失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [category, skillTag, statusFilter, page]);

  function handleStatusFilterChange(next: StatusFilter) {
    setStatusFilter(next);
    setPage(1);
  }

  return (
    <section className="mx-auto max-w-content px-gutter-mobile pb-section-mobile pt-10 md:px-gutter-desktop md:pb-section-desktop md:pt-16">
      <header className="mb-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
        <div className="max-w-reading">
          <h1 className="text-display-mobile text-ink-primary md:text-display">Agent 市场</h1>
          <p className="mt-3 text-lead text-ink-secondary">
            按分类与技能浏览 Agent，找到合适的协作对象。
          </p>
        </div>
        <Link
          to="/agents/new"
          className="whitespace-nowrap rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90"
        >
          发布 Agent
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
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
        }}
        className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center"
      >
        <label className="flex flex-col gap-1.5 text-caption text-ink-secondary sm:flex-row sm:items-center sm:gap-3">
          分类
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className={INPUT_CLASSES}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-caption text-ink-secondary sm:flex-row sm:items-center sm:gap-3">
          技能标签
          <input
            value={skillTag}
            onChange={(event) => setSkillTag(event.target.value)}
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
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {state.items.map((agent) => (
              <article
                key={agent.agentId}
                className="flex flex-col rounded-card border border-divider-light bg-surface-light p-6"
              >
                <div className="mb-3 flex flex-wrap gap-2">
                  <span className="rounded-control border border-divider-light bg-canvas-warm px-2.5 py-1 text-caption text-ink-secondary">
                    {agent.category}
                  </span>
                  {/* Status must be explicit on the card itself, not implied
                      only by which filter surfaced it (real browser
                      walkthrough, T-505 P1) — a card can appear here under
                      the "全部" filter with either status. */}
                  <StatusChip
                    label={agent.status === "ACTIVE" ? "启用中" : "已停用"}
                    tone={agent.status === "ACTIVE" ? "success" : "neutral"}
                  />
                </div>
                <h3 className="mb-2 text-[20px] font-semibold leading-tight text-ink-primary">
                  <Link to={`/agents/${agent.agentId}`} className="hover:text-action-blue">
                    {agent.name}
                  </Link>
                </h3>
                <p className="mb-4 line-clamp-2 flex-grow text-caption text-ink-secondary">
                  {agent.description}
                </p>
                <div className="mb-4 flex flex-wrap gap-2">
                  {agent.skillTags.length > 0 ? (
                    agent.skillTags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-canvas-warm px-2 py-1 text-[13px] text-ink-secondary"
                      >
                        {tag}
                      </span>
                    ))
                  ) : (
                    <span className="text-[13px] text-ink-secondary">无标签</span>
                  )}
                </div>
                <div className="mt-auto grid grid-cols-2 gap-y-3 border-t border-divider-light pt-4 text-caption">
                  <div>
                    <div className="mb-1 text-[12px] text-ink-secondary">完成任务数</div>
                    <div className="text-ink-primary">{agent.completedTaskCount}</div>
                  </div>
                  <div>
                    <div className="mb-1 text-[12px] text-ink-secondary">质量评分</div>
                    <div className="text-ink-primary">
                      <QualityScoreLabel score={agent.qualityScore} />
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {state.items.length === 0 && (
            <p className="py-16 text-center text-body text-ink-secondary">暂无符合条件的 Agent。</p>
          )}
          {state.items.length > 0 && (
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
