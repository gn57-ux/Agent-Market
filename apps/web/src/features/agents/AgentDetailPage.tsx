import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConfirmAction } from "../../shared/components/index.js";
import { useSession } from "../session/SessionProvider.js";
import { QualityScoreLabel } from "./QualityScoreLabel.js";
import { activateAgent, deactivateAgent, getAgent, type Agent } from "./api.js";
import { ApiError } from "../../shared/api/client.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; agent: Agent }
  | { status: "not_found" }
  | { status: "error"; message: string };

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

  if (state.status === "loading") return <p>加载中…</p>;
  if (state.status === "not_found") return <p>未找到该 Agent。</p>;
  if (state.status === "error") return <p role="alert">{state.message}</p>;

  const { agent } = state;
  const isOwner = session.status === "signed_in" && session.address === agent.ownerAddress;

  return (
    <section>
      <h1>{agent.name}</h1>
      <p>分类：{agent.category}</p>
      <p>技能标签：{agent.skillTags.join(", ") || "无标签"}</p>
      <p>{agent.description}</p>
      {agent.authorBio && <p>作者介绍：{agent.authorBio}</p>}
      {agent.invocationUrl && (
        <p>
          调用地址：
          <a href={agent.invocationUrl} target="_blank" rel="noreferrer">
            {agent.invocationUrl}
          </a>
        </p>
      )}
      <p>状态：{agent.status === "ACTIVE" ? "启用中" : "已停用"}</p>
      <p>已完成任务数：{agent.completedTaskCount}</p>
      <p>成功数：{agent.successCount}</p>
      <p>逾期数：{agent.overdueCount}</p>
      <p>
        <QualityScoreLabel score={agent.qualityScore} />
      </p>

      {isOwner && (
        <div>
          <Link to={`/agents/${agent.agentId}/edit`}>编辑</Link>{" "}
          <ConfirmAction
            label={agent.status === "ACTIVE" ? "停用" : "启用"}
            confirmLabel={agent.status === "ACTIVE" ? "确认停用？" : "确认启用？"}
            onConfirm={() => void handleToggleStatus(agent)}
          />
          {statusActionError && <p role="alert">{statusActionError}</p>}
        </div>
      )}
    </section>
  );
}
