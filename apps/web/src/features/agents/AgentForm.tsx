import { useState, type FormEvent } from "react";
import type { CreateAgentInput } from "./api.js";

export interface AgentFormValues {
  name: string;
  description: string;
  category: string;
  skillTagsText: string;
  authorBio: string;
  invocationUrl: string;
  payoutAddress: string;
  pricingModel: string;
  referencePriceText: string;
}

export function emptyAgentFormValues(): AgentFormValues {
  return {
    name: "",
    description: "",
    category: "",
    skillTagsText: "",
    authorBio: "",
    invocationUrl: "",
    payoutAddress: "",
    pricingModel: "",
    referencePriceText: "",
  };
}

export function agentFormValuesFromAgent(agent: {
  name: string;
  description: string;
  category: string;
  skillTags: string[];
  authorBio: string | null;
  invocationUrl: string | null;
  payoutAddress: string;
  pricingModel: string | null;
  referencePrice: string | null;
}): AgentFormValues {
  return {
    name: agent.name,
    description: agent.description,
    category: agent.category,
    skillTagsText: agent.skillTags.join(", "),
    authorBio: agent.authorBio ?? "",
    invocationUrl: agent.invocationUrl ?? "",
    payoutAddress: agent.payoutAddress,
    pricingModel: agent.pricingModel ?? "",
    referencePriceText: agent.referencePrice ?? "",
  };
}

/**
 * Converts the form's plain-text field state into `CreateAgentInput` (the
 * request shape both POST /agents and PATCH /agents/:agentId — as a
 * `Partial` — send). Skill tags are entered as one comma-separated field
 * rather than a dynamic add/remove list widget — the simplest input this
 * page's actual need (a handful of short tags) justifies, not a
 * general-purpose tag editor no other page here needs yet.
 */
export function agentFormValuesToInput(values: AgentFormValues): CreateAgentInput {
  const skillTags = values.skillTagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const referencePrice = values.referencePriceText.trim()
    ? Number(values.referencePriceText)
    : undefined;

  return {
    name: values.name.trim(),
    description: values.description.trim(),
    category: values.category.trim(),
    skillTags,
    authorBio: values.authorBio.trim() || undefined,
    invocationUrl: values.invocationUrl.trim() || undefined,
    payoutAddress: values.payoutAddress.trim(),
    pricingModel: values.pricingModel.trim() || undefined,
    referencePrice,
  };
}

export interface AgentFormProps {
  initialValues: AgentFormValues;
  submitLabel: string;
  pending: boolean;
  errorMessage: string | undefined;
  onSubmit: (input: CreateAgentInput) => void;
}

/** Shared field set for AgentCreatePage and AgentEditPage — both send the
 * same shape of data (PATCH is a `Partial<CreateAgentInput>`, but this form
 * always fills every field it shows, matching design.md's PATCH contract
 * of "whatever's present gets applied"). */
export function AgentForm({
  initialValues,
  submitLabel,
  pending,
  errorMessage,
  onSubmit,
}: AgentFormProps) {
  const [values, setValues] = useState<AgentFormValues>(initialValues);

  function handleChange<K extends keyof AgentFormValues>(key: K) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValues((current) => ({ ...current, [key]: event.target.value }));
    };
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(agentFormValuesToInput(values));
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        名称
        <input value={values.name} onChange={handleChange("name")} required />
      </label>
      <label>
        介绍
        <textarea value={values.description} onChange={handleChange("description")} required />
      </label>
      <label>
        分类
        <input value={values.category} onChange={handleChange("category")} required />
      </label>
      <label>
        技能标签（逗号分隔）
        <input value={values.skillTagsText} onChange={handleChange("skillTagsText")} />
      </label>
      <label>
        作者介绍
        <textarea value={values.authorBio} onChange={handleChange("authorBio")} />
      </label>
      <label>
        调用地址（展示用途，http/https）
        <input value={values.invocationUrl} onChange={handleChange("invocationUrl")} />
      </label>
      <label>
        收款地址
        <input value={values.payoutAddress} onChange={handleChange("payoutAddress")} required />
      </label>
      <label>
        定价模式
        <input value={values.pricingModel} onChange={handleChange("pricingModel")} />
      </label>
      <label>
        参考价格
        <input
          type="number"
          min="0"
          step="any"
          value={values.referencePriceText}
          onChange={handleChange("referencePriceText")}
        />
      </label>
      {errorMessage && <p role="alert">{errorMessage}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "提交中…" : submitLabel}
      </button>
    </form>
  );
}
