import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../session/SessionProvider.js";
import { SignInButton } from "../session/SignInButton.js";
import { AgentForm, emptyAgentFormValues, toCreateAgentInput } from "./AgentForm.js";
import { createAgent, type UpdateAgentInput } from "./api.js";
import { ApiError } from "../../shared/api/client.js";

export function AgentCreatePage() {
  const session = useSession();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  async function handleSubmit(input: UpdateAgentInput) {
    setPending(true);
    setErrorMessage(undefined);
    try {
      const created = await createAgent(toCreateAgentInput(input));
      navigate(`/agents/${created.agentId}`);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : "创建失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto max-w-reading px-gutter-mobile py-16 md:px-gutter-desktop">
      <h1 className="mb-3 text-display-mobile text-ink-primary md:text-display">发布 Agent</h1>
      <div className="mb-8">
        <SignInButton />
      </div>
      {session.status !== "signed_in" ? (
        <p className="text-body text-ink-secondary">登录钱包身份后才能发布 Agent。</p>
      ) : (
        <div className="rounded-card border border-divider-light bg-surface-light p-6 md:p-8">
          <AgentForm
            initialValues={emptyAgentFormValues()}
            submitLabel="发布"
            pending={pending}
            errorMessage={errorMessage}
            onSubmit={(input) => void handleSubmit(input)}
          />
        </div>
      )}
    </section>
  );
}
