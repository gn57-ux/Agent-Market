import { z } from "zod";
import { resolveOllamaBaseUrl } from "../embeddings/ollama-provider.js";

/**
 * F-2201/T-2201 (design.md 决策 1): Qwen Prompt classification chosen over
 * training a BERT-class classifier — zero-shot/few-shot via prompt, not a
 * trained model (see design.md "决策 1" comparison table; F-2209's real
 * evaluation set is the judge of whether this needs to be upgraded to a
 * trained classifier, not a decision made here). Reuses `resolveOllamaBaseUrl`
 * from `embeddings/ollama-provider.ts` (same local Ollama daemon Feature 13
 * already validated) but needs its OWN model config — classification is a
 * different model role from embedding/scoring, so neither
 * `OLLAMA_EMBEDDING_MODEL` nor `OLLAMA_EVALUATION_MODEL` may be silently
 * reused (same reasoning `ai-scorer.ts` already documents for its own
 * dedicated env var).
 */

/**
 * The closed set of intents F-2201 requires. A union type (not a bare
 * `string`) so every switch/handler over `IntentCategory` gets exhaustiveness
 * checking downstream (CLAUDE.md 原则 8, "尽可能让非法状态无法表示") — a
 * fifth category can only be added here, never smuggled in through a caller
 * that happens to accept any string.
 */
export const INTENT_CATEGORIES = [
  "PLATFORM_USAGE",
  "TASK_STATUS",
  "DISPUTE_PROCESS",
  "UNHANDLED",
] as const;

export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

/** This machine's real installed models are `qwen3:8b`, `qwen3.6:27b`,
 * `gemma4:26b`, `bge-m3:latest` (verified via a real `curl
 * http://localhost:11434/api/tags` during this Task's implementation) —
 * `qwen2.5:7b` (ai-scorer.ts's own default) is NOT installed here. `qwen3:8b`
 * is the smallest/fastest real Qwen model actually present, so it is the
 * default for a latency-sensitive classification call; a different
 * environment can override via `OLLAMA_INTENT_MODEL` without touching code. */
const DEFAULT_OLLAMA_INTENT_MODEL = "qwen3:8b";

export function resolveIntentClassificationModel(): string {
  return process.env.OLLAMA_INTENT_MODEL ?? DEFAULT_OLLAMA_INTENT_MODEL;
}

/** A short classification completes well under this window on real local
 * hardware (verified during this Task's own testing); long enough to
 * tolerate a cold model load without masking a genuinely hung daemon (same
 * reasoning as `ai-scorer.ts`'s `REQUEST_TIMEOUT_MS`).
 *
 * N4 real finding (T-2205, P2): a real fault-isolation test needs to
 * exercise the genuine TIMEOUT path (a server that accepts a connection
 * but never responds), not just an immediate connection-refused failure —
 * otherwise a regression that silently dropped the `AbortSignal.timeout`
 * below would go undetected. Waiting out the real 30s in a test is
 * impractical, so this constant is overridable via
 * `OLLAMA_INTENT_TIMEOUT_MS`, same test-seam convention
 * `ollama-provider.ts`'s own constructor `timeoutMs` option already
 * establishes — production code never sets this env var, so real
 * behavior is unchanged. */
function resolveRequestTimeoutMs(): number {
  const raw = process.env.OLLAMA_INTENT_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

export interface IntentClassificationResult {
  intent: IntentCategory;
  rationale?: string;
}

/**
 * Thrown for every failure mode (Ollama unreachable, non-2xx, malformed/
 * non-JSON response, response JSON whose `intent` isn't one of the closed
 * `INTENT_CATEGORIES` values) — matches `AiScorerError`'s own "callers never
 * need to distinguish why, only that it failed" contract. A caller (F-2204's
 * router; not built in this Task) can catch this and treat it identically to
 * an explicit `UNHANDLED` classification — routing to human is always safe
 * when classification itself can't be trusted. The message never includes
 * raw model output (same logging discipline as `AiScorerError`) — the real
 * cause stays in `cause` for server-side log-only inspection.
 */
export class IntentClassifierError extends Error {}

/**
 * N4 real finding (round 1, T-2201, P2): `classifyIntent` is a public
 * boundary that will be called with real, untrusted end-user chat input
 * (F-2210's fault-isolation requirement makes this doubly important — a
 * customer-service call must never become a resource-exhaustion vector
 * for the same local Ollama daemon other Features already depend on).
 * A generous-but-bounded ceiling on a genuine chat message; anything
 * longer is rejected BEFORE any network call is made, not truncated
 * silently (truncation could change the actual meaning of a long
 * question without the caller knowing).
 */
// Exported (T-2202): `answer-generator.ts` relies on `classifyIntent` being
// the FIRST call in its own pipeline and being called with the raw,
// unbounded user message — an oversized message is rejected here, before
// any network call, and that rejection (via `IntentClassifierError`) is
// what keeps T-2202 from having to duplicate this exact same bound
// independently (CLAUDE.md 原则 6: 设计知识只能有一个归属 — "how long is too
// long for a customer-service chat message" has exactly one owner).
export const MAX_USER_MESSAGE_LENGTH = 2000;

/** `/api/generate`'s real response envelope — only `response` (the model's
 * own JSON-formatted text output, parsed a second time below) is used. */
const ollamaGenerateEnvelopeSchema = z.object({ response: z.string() });

/**
 * The model's own JSON output must match this shape. `intent` is restricted
 * to the closed `INTENT_CATEGORIES` enum via `z.enum` — real model output is
 * untrusted input (same trust boundary `ai-scorer.ts` already applies to its
 * own score/rationale shape), so an out-of-enum value the model hallucinates
 * is rejected here, not silently coerced or passed through.
 */
const intentClassificationSchema = z.object({
  intent: z.enum(INTENT_CATEGORIES),
  rationale: z.string().optional(),
});

// N4 real finding (round 2, T-2202, P1): T-2202's own real integration
// test discovered that a genuine platform-RULE FAQ question ("验收窗口
// 一般是多久" — a fact the knowledge base actually has) reliably
// classified UNHANDLED, because PLATFORM_USAGE's examples only described
// action/操作类 questions ("怎么发布任务"), not rule/规则类 lookups. That
// silently sends a real, answerable question straight to human escalation
// without ever consulting the knowledge base — the exact failure mode
// F-2201/AC-2201 exist to prevent. PLATFORM_USAGE's definition now
// explicitly covers general platform-mechanics rule/FAQ questions too
// (staking ratio, review window, matching), NOT just actions.
//
// First attempt at this fix made PLATFORM_USAGE's rule/FAQ wording broad
// enough that it also swallowed a DISPUTE_PROCESS-specific rule question
// ("争议流程大概要多久才能有结果") — verified via a real classification
// run. DISPUTE_PROCESS's own definition now explicitly claims ALL
// dispute/arbitration-related questions (action or rule/FAQ shaped)
// as its own domain, and PLATFORM_USAGE's examples are scoped to
// non-dispute platform mechanics, so the two categories no longer
// compete for the same real question.
function buildClassificationPrompt(userMessage: string): string {
  return [
    "你是 Agent Market 平台的客服意图分类助手。请阅读用户的问题，从下面的闭合类别中选出唯一最符合的一个：",
    "- PLATFORM_USAGE：与争议/仲裁无关的平台使用咨询，既包括操作类问题（如怎么发布任务、怎么接单、怎么充值），也包括平台规则/FAQ 类问题（如验收窗口一般是多久、质押比例是多少这类询问非争议类具体规则数值或流程细节的问题）",
    "- TASK_STATUS：针对用户自己某个具体任务的状态查询（如我的任务为什么还没匹配、我这个任务进度如何），而不是询问平台的通用规则",
    "- DISPUTE_PROCESS：任何与争议/仲裁相关的咨询，无论是操作类（如交付不合格我该怎么办、如何申请仲裁）还是规则/FAQ 类（如争议流程大概要多久、仲裁由谁裁决）——只要问题涉及争议或仲裁，一律归入这一类，不归入 PLATFORM_USAGE",
    "- UNHANDLED：以上都不符合，或问题与平台无关，需要转人工处理",
    "只输出符合以下 JSON 格式的内容，不要输出任何其他文字：",
    '{"intent": "<上面四个类别之一>", "rationale": "<不超过100字的中文简短理由>"}',
    "",
    `用户问题：${userMessage}`,
  ].join("\n");
}

/**
 * Calls the local Ollama `/api/generate` endpoint to classify `userMessage`
 * into exactly one of `INTENT_CATEGORIES`. Pure computation — never writes
 * anything, never calls any other service. Every failure mode (network,
 * timeout, malformed JSON, out-of-enum category) surfaces as
 * `IntentClassifierError`; this function never returns a value outside the
 * closed `IntentCategory` union, so a caller can trust the type without
 * additional runtime narrowing.
 */
export async function classifyIntent(userMessage: string): Promise<IntentClassificationResult> {
  if (userMessage.length > MAX_USER_MESSAGE_LENGTH) {
    throw new IntentClassifierError(
      `用户消息过长（超过 ${MAX_USER_MESSAGE_LENGTH} 字符），已拒绝分类请求。`,
    );
  }

  const baseUrl = resolveOllamaBaseUrl();
  const model = resolveIntentClassificationModel();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildClassificationPrompt(userMessage),
        format: "json",
        stream: false,
      }),
      signal: AbortSignal.timeout(resolveRequestTimeoutMs()),
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    throw new IntentClassifierError(isTimeout ? "意图分类调用超时。" : "意图分类调用网络错误。", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new IntentClassifierError(`意图分类服务返回了非成功状态码（${response.status}）。`);
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (error) {
    throw new IntentClassifierError("意图分类服务响应不是合法 JSON。", { cause: error });
  }

  const envelopeParsed = ollamaGenerateEnvelopeSchema.safeParse(rawBody);
  if (!envelopeParsed.success) {
    throw new IntentClassifierError("意图分类服务响应形状不符合预期。", {
      cause: envelopeParsed.error,
    });
  }

  let modelOutput: unknown;
  try {
    modelOutput = JSON.parse(envelopeParsed.data.response);
  } catch (error) {
    throw new IntentClassifierError("模型输出不是合法 JSON。", { cause: error });
  }

  const classificationParsed = intentClassificationSchema.safeParse(modelOutput);
  if (!classificationParsed.success) {
    throw new IntentClassifierError("模型输出的意图分类结构不符合预期。", {
      cause: classificationParsed.error,
    });
  }

  return classificationParsed.data;
}
