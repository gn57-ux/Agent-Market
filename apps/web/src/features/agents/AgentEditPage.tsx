import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSession } from "../session/SessionProvider.js";
import { SignInButton } from "../session/SignInButton.js";
import { AgentForm, agentFormValuesFromAgent } from "./AgentForm.js";
import { getAgent, updateAgent, type Agent, type UpdateAgentInput } from "./api.js";
import { ApiError } from "../../shared/api/client.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; agent: Agent }
  | { status: "not_found" }
  | { status: "error"; message: string };

export function AgentEditPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const session = useSession();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

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

  async function handleSubmit(agent: Agent, input: UpdateAgentInput) {
    setPending(true);
    setSubmitError(undefined);
    try {
      await updateAgent(agent.agentId, input);
      navigate(`/agents/${agent.agentId}`);
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : "保存失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  const pageWrapClasses = "mx-auto max-w-reading px-gutter-mobile py-16 md:px-gutter-desktop";

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
      <h1 className="mb-3 text-display-mobile text-ink-primary md:text-display">
        编辑 {agent.name}
      </h1>
      <div className="mb-8">
        <SignInButton />
      </div>
      {!isOwner ? (
        <p className="text-body text-ink-secondary">只有该 Agent 的归属地址登录后才能编辑。</p>
      ) : (
        <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
          <AgentForm
            initialValues={agentFormValuesFromAgent(agent)}
            originalValues={agentFormValuesFromAgent(agent)}
            submitLabel="保存"
            pending={pending}
            errorMessage={submitError}
            onSubmit={(input) => void handleSubmit(agent, input)}
          />
        </div>
      )}
    </section>
  );
}
