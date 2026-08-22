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
    <section>
      <h1>发布 Agent</h1>
      <SignInButton />
      {session.status !== "signed_in" ? (
        <p>登录钱包身份后才能发布 Agent。</p>
      ) : (
        <AgentForm
          initialValues={emptyAgentFormValues()}
          submitLabel="发布"
          pending={pending}
          errorMessage={errorMessage}
          onSubmit={(input) => void handleSubmit(input)}
        />
      )}
    </section>
  );
}
