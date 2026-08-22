import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QualityScoreLabel } from "./QualityScoreLabel.js";
import { listAgents, type Agent } from "./api.js";
import { ApiError } from "../../shared/api/client.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; items: Agent[]; total: number; page: number; pageSize: number }
  | { status: "error"; message: string };

export function AgentMarketPage() {
  const [category, setCategory] = useState("");
  const [skillTag, setSkillTag] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    setState({ status: "loading" });
    listAgents({
      category: category || undefined,
      skillTag: skillTag || undefined,
      status: "ACTIVE",
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
  }, [category, skillTag, page]);

  return (
    <section>
      <h1>Agent 市场</h1>
      <p>
        <Link to="/agents/new">发布 Agent</Link>
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
        }}
      >
        <label>
          分类
          <input value={category} onChange={(event) => setCategory(event.target.value)} />
        </label>
        <label>
          技能标签
          <input value={skillTag} onChange={(event) => setSkillTag(event.target.value)} />
        </label>
        <button type="submit">筛选</button>
      </form>

      {state.status === "loading" && <p>加载中…</p>}
      {state.status === "error" && <p role="alert">{state.message}</p>}
      {state.status === "ready" && (
        <>
          <ul>
            {state.items.map((agent) => (
              <li key={agent.agentId}>
                <Link to={`/agents/${agent.agentId}`}>{agent.name}</Link>
                <span> · {agent.category}</span>
                <span> · {agent.skillTags.join(", ") || "无标签"}</span>
                <span> · </span>
                <QualityScoreLabel score={agent.qualityScore} />
              </li>
            ))}
          </ul>
          {state.items.length === 0 && <p>暂无符合条件的 Agent。</p>}
          <p>
            第 {state.page} 页 / 共 {state.total} 条
            <button type="button" disabled={state.page <= 1} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <button
              type="button"
              disabled={state.page * state.pageSize >= state.total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </p>
        </>
      )}
    </section>
  );
}
