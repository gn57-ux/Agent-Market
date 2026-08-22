import { useState, type FormEvent } from "react";
import type { CreateAgentInput, UpdateAgentInput } from "./api.js";

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
 * For one optional text field: `undefined` when unchanged from
 * `originalText` (so PATCH doesn't resend/overwrite a field the user never
 * touched — this is also what keeps `referencePrice` from silently
 * rounding an untouched high-precision value, since an unchanged field is
 * never re-parsed through `Number()` at all — Codex review, T-505 round 1,
 * P2); `null` when changed TO blank (an explicit clear — apps/api's
 * `updateAgentSchema` distinguishes this from "don't change"); otherwise
 * the new trimmed value.
 */
function optionalTextField(current: string, original: string): string | null | undefined {
  const trimmedCurrent = current.trim();
  if (trimmedCurrent === original.trim()) return undefined;
  return trimmedCurrent || null;
}

/**
 * Converts the form's plain-text field state into `UpdateAgentInput`,
 * diffed against `originalValues`. AgentCreatePage calls this with
 * `emptyAgentFormValues()` as `originalValues` (see `toCreateAgentInput`
 * below) — every field then compares against a blank baseline, so a blank
 * field always resolves to `undefined` ("not provided"), never `null`
 * ("clear"): a create request has nothing to clear. AgentEditPage passes
 * the Agent's actual current values, enabling real change/clear detection.
 *
 * Skill tags are entered as one comma-separated field rather than a
 * dynamic add/remove list widget — the simplest input this page's actual
 * need (a handful of short tags) justifies, not a general-purpose tag
 * editor no other page here needs yet. Always resent as-is (no unchanged-
 * omission): there's no precision or accidental-overwrite risk for tags
 * the way there is for `referencePrice`.
 */
export function agentFormValuesToInput(
  values: AgentFormValues,
  originalValues: AgentFormValues,
): UpdateAgentInput {
  const skillTags = values.skillTagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const trimmedPrice = values.referencePriceText.trim();
  const referencePrice: number | null | undefined =
    trimmedPrice === originalValues.referencePriceText.trim()
      ? undefined
      : trimmedPrice
        ? Number(trimmedPrice)
        : null;

  return {
    name: values.name.trim(),
    description: values.description.trim(),
    category: values.category.trim(),
    skillTags,
    authorBio: optionalTextField(values.authorBio, originalValues.authorBio),
    invocationUrl: optionalTextField(values.invocationUrl, originalValues.invocationUrl),
    payoutAddress: values.payoutAddress.trim(),
    pricingModel: optionalTextField(values.pricingModel, originalValues.pricingModel),
    referencePrice,
  };
}

/**
 * Narrows an `UpdateAgentInput` (AgentForm's one output shape) down to
 * `CreateAgentInput` for AgentCreatePage's `POST /agents` call. Defensive
 * `?? undefined`/`?? ""` fallbacks rather than an assertion: algebraically
 * a `null` can never actually appear here (AgentCreatePage always diffs
 * against `emptyAgentFormValues()`, so every optional field is either
 * unchanged-from-blank → `undefined` or changed-to-a-value → the value;
 * see `agentFormValuesToInput`'s doc comment), but this keeps that
 * invariant from being load-bearing at the type level.
 */
export function toCreateAgentInput(input: UpdateAgentInput): CreateAgentInput {
  return {
    name: input.name ?? "",
    description: input.description ?? "",
    category: input.category ?? "",
    skillTags: input.skillTags ?? [],
    authorBio: input.authorBio ?? undefined,
    invocationUrl: input.invocationUrl ?? undefined,
    payoutAddress: input.payoutAddress ?? "",
    pricingModel: input.pricingModel ?? undefined,
    referencePrice: input.referencePrice ?? undefined,
  };
}

export interface AgentFormProps {
  initialValues: AgentFormValues;
  /** Pass the Agent's current values for AgentEditPage, enabling real
   * change/clear detection. Omitted for AgentCreatePage — see
   * `agentFormValuesToInput`'s doc comment for why that's the correct
   * "nothing to diff against yet" baseline for creation. */
  originalValues?: AgentFormValues;
  submitLabel: string;
  pending: boolean;
  errorMessage: string | undefined;
  onSubmit: (input: UpdateAgentInput) => void;
}

/** Shared field set for AgentCreatePage and AgentEditPage. */
export function AgentForm({
  initialValues,
  originalValues,
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
    onSubmit(agentFormValuesToInput(values, originalValues ?? emptyAgentFormValues()));
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
