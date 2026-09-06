import { z } from "zod";
import { resolveOllamaBaseUrl } from "../embeddings/ollama-provider.js";

/**
 * F-2003/T-2003 (design.md 决策 2): local generative-model scoring
 * ASSIST — never a final score. Reuses `resolveOllamaBaseUrl` from
 * `embeddings/ollama-provider.ts` (same local Ollama daemon, Feature 13's
 * "纯本地方案，禁止任何付费 API" boundary applies identically here) but
 * needs its OWN model config: embedding and generative completion are
 * different model roles, so `OLLAMA_EMBEDDING_MODEL` must not be silently
 * reused for this — a wrong assumption here would just as silently produce
 * garbage scores as it would garbage vectors.
 *
 * Design comparison (CLAUDE.md 原则 3): (A, chosen) call Ollama's
 * `/api/generate` non-streaming with `format: "json"` (Ollama's own
 * structured-output constraint, forcing the model to emit parseable JSON)
 * — one HTTP call, matches `ollama-provider.ts`'s own request shape almost
 * exactly. (B, rejected) `/api/chat` with a system+user message array —
 * closer to typical chat-completion styling and would allow a future
 * multi-turn refinement flow, but this Task is a single-shot "score this
 * one submission" call with no conversation state to carry, so the extra
 * message-array construction buys nothing today.
 */
const DEFAULT_OLLAMA_EVALUATION_MODEL = "qwen2.5:7b";

export function resolveOllamaEvaluationModel(): string {
  return process.env.OLLAMA_EVALUATION_MODEL ?? DEFAULT_OLLAMA_EVALUATION_MODEL;
}

/** Real local generation for a short scoring rationale comfortably
 * completes in well under this window; long enough to tolerate a cold
 * model load without masking a genuinely hung daemon (same reasoning as
 * `ollama-provider.ts`'s own `REQUEST_TIMEOUT_MS`, longer here since
 * generation is slower than embedding). */
const REQUEST_TIMEOUT_MS = 30_000;

export interface AiScoreSuggestion {
  score: number;
  rationale: string;
}

/**
 * Thrown for every failure mode (Ollama unreachable, non-2xx, malformed/
 * non-JSON response, response JSON that doesn't match the expected
 * `{score, rationale}` shape) — matches `EmbeddingProviderError`'s own
 * "callers never need to distinguish why, only that it failed" contract.
 * The message never includes raw model output (F-1314's logging
 * constraint, reused here) — the real cause stays in `cause` for
 * server-side log-only inspection.
 */
export class AiScorerError extends Error {}

/** `/api/generate`'s real response envelope — only `response` (the model's
 * own JSON-formatted text output, itself parsed a second time below) is
 * used; every other field (`done`, `context`, timing stats, etc.) is
 * ignored. */
const ollamaGenerateEnvelopeSchema = z.object({ response: z.string() });

/** The score/rationale shape the model's own JSON output must match — a
 * real system boundary (untrusted model output), same convention as
 * `dispatch.client.ts`'s `matchResponseSchema` and `rule-scorer.ts`'s own
 * criteria schema. `score` is coerced then range-checked rather than
 * trusting the model to only ever emit an integer in [0,100]. */
const aiScoreSuggestionSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  rationale: z.string().min(1),
});

function buildScoringPrompt(taskPrompt: string, submittedContent: string): string {
  return [
    "你是一名专业能力评测助手。请阅读以下评测题目和提交内容，给出一个 0-100 的分数建议和简短理由。",
    "这只是提供给人工审核员参考的建议分数，不是最终评分，请如实评估，不要迎合。",
    "只输出符合以下 JSON 格式的内容，不要输出任何其他文字：",
    '{"score": <0-100的整数>, "rationale": "<不超过200字的中文理由>"}',
    "",
    `评测题目：${taskPrompt}`,
    "",
    `提交内容：${submittedContent}`,
  ].join("\n");
}

/**
 * Calls the local Ollama `/api/generate` endpoint to produce an ADVISORY
 * score suggestion for a `HUMAN_REQUIRED` submission. Never writes
 * anything itself (pure computation, matching `rule-scorer.ts`'s own
 * "fetch/decide split" — `routes.ts`'s AI-suggestion endpoint owns the
 * actual `insertResult` write) and never called for the FINAL score —
 * design.md 决策 2's explicit "不允许 AI 评分直接成为终局分数" boundary is
 * enforced by the CALLER always writing `scored_by = 'AI'`, never
 * `'HUMAN'`, for whatever this function returns.
 */
export async function generateAiScoreSuggestion(
  taskPrompt: string,
  submittedContent: string,
): Promise<AiScoreSuggestion> {
  const baseUrl = resolveOllamaBaseUrl();
  const model = resolveOllamaEvaluationModel();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildScoringPrompt(taskPrompt, submittedContent),
        format: "json",
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    throw new AiScorerError(isTimeout ? "AI 评分调用超时。" : "AI 评分调用网络错误。", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new AiScorerError(`AI 评分服务返回了非成功状态码（${response.status}）。`);
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (error) {
    throw new AiScorerError("AI 评分服务响应不是合法 JSON。", { cause: error });
  }

  const envelopeParsed = ollamaGenerateEnvelopeSchema.safeParse(rawBody);
  if (!envelopeParsed.success) {
    throw new AiScorerError("AI 评分服务响应形状不符合预期。", { cause: envelopeParsed.error });
  }

  let modelOutput: unknown;
  try {
    modelOutput = JSON.parse(envelopeParsed.data.response);
  } catch (error) {
    throw new AiScorerError("模型输出不是合法 JSON。", { cause: error });
  }

  const suggestionParsed = aiScoreSuggestionSchema.safeParse(modelOutput);
  if (!suggestionParsed.success) {
    throw new AiScorerError("模型输出的评分结构不符合预期。", { cause: suggestionParsed.error });
  }

  return suggestionParsed.data;
}
