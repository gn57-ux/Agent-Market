import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConfirmAction, StatusChip } from "../../shared/components/index.js";
import { useSession } from "../session/SessionProvider.js";
import { QualityScoreLabel } from "./QualityScoreLabel.js";
import { activateAgent, deactivateAgent, getAgent, type Agent } from "./api.js";
import { ApiError } from "../../shared/api/client.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; agent: Agent }
  | { status: "not_found" }
  | { status: "error"; message: string };

const STAT_CARD_CLASSES = "rounded-card-compact border border-divider-light bg-canvas-warm p-4";

/** design.md: "Agent Detail: large capability statement, evidence, verified
 * task history and pricing." — the hero card carries the capability
 * statement (name + description + skills); the stats grid is the
 * "evidence"; pricing sits in the sidebar next to the owner-only actions. */
export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const session = useSession();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [statusActionError, setStatusActionError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!agentId) return;
    let ignore = false;
    setState({ status: "loading" });
    getAgent(agentId)
      .then((agent) => {
        if (!ignore) setState({ status: "ready", agent });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: "not_found" });
          return;
        }
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载 Agent 详情失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [agentId]);

  async function handleToggleStatus(agent: Agent) {
    setStatusActionError(undefined);
    try {
      const updated =
        agent.status === "ACTIVE"
          ? await deactivateAgent(agent.agentId)
          : await activateAgent(agent.agentId);
      setState({ status: "ready", agent: updated });
    } catch (error) {
      setStatusActionError(error instanceof ApiError ? error.message : "操作失败，请重试。");
    }
  }

  const pageWrapClasses = "mx-auto max-w-content px-gutter-mobile py-16 md:px-gutter-desktop";

  if (state.status === "loading") {
    return (
      <div className={pageWrapClasses}>
        <p className="text-body text-ink-secondary">加载中…</p>
      </div>
    );
  }
  if (state.status === "not_found") {
    return (
      <div className={pageWrapClasses}>
        <p className="text-body text-ink-secondary">未找到该 Agent。</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={pageWrapClasses}>
        <p role="alert" className="text-body text-warning">
          {state.message}
        </p>
      </div>
    );
  }

  const { agent } = state;
  const isOwner = session.status === "signed_in" && session.address === agent.ownerAddress;

  return (
    <section className={pageWrapClasses}>
      {/* Hero: capability statement */}
      <div className="mb-8 rounded-card border border-divider-light bg-surface-light p-8">
        <div className="mb-4 flex flex-wrap gap-2">
          <StatusChip
            label={agent.status === "ACTIVE" ? "启用中" : "已停用"}
            tone={agent.status === "ACTIVE" ? "success" : "neutral"}
          />
          <StatusChip label={agent.category} tone="info" />
        </div>
        <h1 className="mb-4 text-title text-ink-primary">{agent.name}</h1>
        <p className="mb-6 max-w-reading text-body text-ink-secondary">{agent.description}</p>
        <div className="flex flex-wrap gap-2">
          {agent.skillTags.length > 0 ? (
            agent.skillTags.map((tag) => (
              <span
                key={tag}
                className="rounded-input border border-divider-light bg-canvas-warm px-3 py-1 text-caption text-ink-secondary"
              >
                {tag}
              </span>
            ))
          ) : (
            <span className="text-caption text-ink-secondary">无标签</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
        {/* Main: evidence + capability history */}
        <div className="flex flex-col gap-6 md:col-span-8">
          <div className="rounded-card border border-divider-light bg-surface-light p-6">
            <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">履约表现</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className={STAT_CARD_CLASSES}>
                <div className="mb-1 text-[12px] text-ink-secondary">已完成任务数</div>
                <div className="text-[20px] text-ink-primary">{agent.completedTaskCount}</div>
              </div>
              <div className={STAT_CARD_CLASSES}>
                <div className="mb-1 text-[12px] text-ink-secondary">成功数</div>
                <div className="text-[20px] text-ink-primary">{agent.successCount}</div>
              </div>
              <div className={STAT_CARD_CLASSES}>
                <div className="mb-1 text-[12px] text-ink-secondary">逾期数</div>
                <div className="text-[20px] text-ink-primary">{agent.overdueCount}</div>
              </div>
              <div className={STAT_CARD_CLASSES}>
                <div className="mb-1 text-[12px] text-ink-secondary">质量评分</div>
                <div className="text-[20px] text-ink-primary">
                  <QualityScoreLabel score={agent.qualityScore} />
                </div>
              </div>
            </div>
          </div>

          {agent.authorBio && (
            <div className="rounded-card border border-divider-light bg-surface-light p-6">
              <h2 className="mb-3 text-[20px] font-semibold text-ink-primary">作者介绍</h2>
              <p className="text-body text-ink-secondary">{agent.authorBio}</p>
            </div>
          )}

          {agent.invocationUrl && (
            <div className="rounded-card border border-divider-light bg-surface-light p-6">
              <h2 className="mb-3 text-[20px] font-semibold text-ink-primary">调用地址</h2>
              <a
                href={agent.invocationUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all text-caption text-action-blue hover:underline"
              >
                {agent.invocationUrl}
              </a>
            </div>
          )}
        </div>

        {/* Sidebar: pricing + owner actions */}
        <aside className="flex flex-col gap-6 md:col-span-4">
          <div className="rounded-card border border-divider-light bg-surface-light p-6">
            <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">定价</h2>
            <dl className="space-y-3 text-caption">
              <div className="flex justify-between">
                <dt className="text-ink-secondary">定价模式</dt>
                <dd className="text-ink-primary">{agent.pricingModel ?? "未设置"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-secondary">参考价格</dt>
                <dd className="font-mono text-ink-primary">{agent.referencePrice ?? "未设置"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-secondary">归属地址</dt>
                <dd className="font-mono text-ink-primary">
                  {agent.ownerAddress.slice(0, 6)}…{agent.ownerAddress.slice(-4)}
                </dd>
              </div>
            </dl>
          </div>

          {isOwner && (
            <div className="rounded-card border border-divider-light bg-surface-light p-6">
              <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">管理</h2>
              <div className="flex flex-col gap-3">
                <Link
                  to={`/agents/${agent.agentId}/edit`}
                  className="rounded-control border border-divider-light px-4 py-2 text-center text-caption font-medium text-ink-primary transition-colors hover:bg-canvas-warm"
                >
                  编辑
                </Link>
                <ConfirmAction
                  label={agent.status === "ACTIVE" ? "停用" : "启用"}
                  confirmLabel={agent.status === "ACTIVE" ? "确认停用？" : "确认启用？"}
                  onConfirm={() => void handleToggleStatus(agent)}
                />
                {statusActionError && (
                  <p role="alert" className="text-caption text-warning">
                    {statusActionError}
                  </p>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
