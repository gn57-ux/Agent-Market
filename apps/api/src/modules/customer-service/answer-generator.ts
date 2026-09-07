import { z } from "zod";
import type { Queryable } from "../../db/pool.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import { computeEmbeddingVersion } from "../embeddings/embed-on-save.js";
import { OllamaEmbeddingProvider, resolveOllamaBaseUrl } from "../embeddings/ollama-provider.js";
import type { TaskRow, TaskStatusValue } from "../tasks/repository.js";
import { listTasksQuerySchema } from "../tasks/schema.js";
import { listTasksForMarket } from "../tasks/service.js";
import { classifyIntent, IntentClassifierError, type IntentCategory } from "./intent-classifier.js";
import { searchKbArticles } from "./kb-repository.js";

/**
 * F-2203/F-2204/F-2207, T-2202: the RAG retrieval + generation pipeline.
 * Ties together T-2200's `kb-repository.ts` (retrieval) and T-2201's
 * `intent-classifier.ts` (routing), then adds this Task's own piece: a
 * real local Qwen generation call over ONLY the retrieved content. This
 * module never persists anything (no `customer_service_conversations`/
 * `customer_service_messages` tables exist yet — that's a distinct,
 * not-yet-built concern per tasks.md's T-2202 scope) and never performs
 * any fund/task-mutating operation (design.md's "范围边界": "客服系统不执行
 * 任何实际的资金/任务变更操作").
 */

/**
 * The honest fallback used for every "we must not fabricate an answer"
 * exit: no relevant knowledge, a generation failure, or the model's own
 * admission that the retrieved context doesn't answer the question. One
 * literal string (not several near-duplicates) so a future reviewer only
 * has to check ONE place for what F-2205's escalation signal actually says
 * to the user.
 */
const ESCALATION_ANSWER = "很抱歉，我不确定这个问题的答案，已为您转接人工客服处理。";

export interface AnswerGenerationResult {
  intent: IntentCategory;
  answer: string;
  /** Empty whenever `escalate` is true for a reason other than "the model
   * partially answered but only some cited articles survived validation"
   * — see `generateAnswer`'s own step-by-step doc comment. */
  citedKbArticleIds: string[];
  escalate: boolean;
}

function escalationResult(intent: IntentCategory): AnswerGenerationResult {
  return { intent, answer: ESCALATION_ANSWER, citedKbArticleIds: [], escalate: true };
}

/**
 * T-2200's own real-Postgres verification
 * (`kb-articles-migration.integration.test.ts` /
 * `seed-kb-articles.integration.test.ts`) already established that a
 * genuine top match against this exact KB dataset on `bge-m3` scores
 * meaningfully above 0.3 for an on-topic query (e.g. "验收窗口是多久" →
 * similarity > 0.3), while a stale/wrong-vector-space row is excluded
 * upstream by `searchKbArticles`'s own `embedding_version` filter, not by
 * this floor. Reusing that already-empirically-checked number here (rather
 * than picking a new untested one) is what AC-2202's "no fabricated
 * answer when the KB genuinely has nothing relevant" turns into a real,
 * bounded structural gate instead of an unbounded "always ask the model
 * anyway" pass-through.
 */
const SIMILARITY_FLOOR = 0.3;

/** How many top candidates `searchKbArticles` returns before the
 * similarity floor is applied — `searchKbArticles`'s own default. Passed
 * explicitly (not left implicit) so this module's retrieval breadth is
 * visible at the call site, not hidden behind another module's default. */
const KB_SEARCH_LIMIT = 5;

/** This machine's real installed models (verified via a real `curl
 * http://localhost:11434/api/tags` during this Task's implementation, same
 * check `intent-classifier.ts` already had to do independently since
 * generation is a different model role from classification/embedding):
 * `qwen3:8b`, `qwen3.6:27b`, `gemma4:26b`, `bge-m3:latest`.
 * `intent-classification-examples.ts`/requirements.md's v1.1 changelog
 * already confirmed `qwen3:8b` as this environment's real local Qwen
 * generation model, so it is reused here as the default rather than
 * assuming `ai-scorer.ts`'s own default (`qwen2.5:7b`, NOT installed on
 * this machine) would work for this Task. A different environment can
 * override via `OLLAMA_ANSWER_MODEL` without touching code. */
const DEFAULT_OLLAMA_ANSWER_MODEL = "qwen3:8b";

export function resolveAnswerGenerationModel(): string {
  return process.env.OLLAMA_ANSWER_MODEL ?? DEFAULT_OLLAMA_ANSWER_MODEL;
}

/** Real local generation over a handful of short KB snippets comfortably
 * completes well under this window; long enough to tolerate a cold model
 * load without masking a genuinely hung daemon (same reasoning as
 * `ai-scorer.ts`'s/`intent-classifier.ts`'s own `REQUEST_TIMEOUT_MS`).
 *
 * Overridable via `OLLAMA_ANSWER_TIMEOUT_MS` for the same real
 * timeout-path test reason `intent-classifier.ts`'s own
 * `resolveRequestTimeoutMs` documents (N4, T-2205, P2) — production never
 * sets this env var. */
function resolveRequestTimeoutMs(): number {
  const raw = process.env.OLLAMA_ANSWER_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

/** Thrown for every generation-call failure mode (network/timeout,
 * non-2xx, malformed/non-JSON response, response JSON that doesn't match
 * the expected shape) — never allowed to escape `generateAnswer` itself
 * (F-2210: a generation-service fault must degrade to the honest
 * escalation answer, not propagate as an unhandled rejection). Kept
 * private (not exported) since no caller outside this module is ever
 * meant to observe it — `generateAnswer`'s own public contract is that it
 * never throws for a downstream service failure. */
class AnswerGenerationError extends Error {}

/** The prompt's own instruction to the model (see `buildAnswerPrompt`):
 * an answerable response must be non-empty and at most 300 Chinese
 * characters. */
const MAX_ANSWER_LENGTH = 300;

/** The model's own JSON output must match this shape — untrusted input,
 * same trust boundary `ai-scorer.ts`/`intent-classifier.ts` already apply
 * to their own model output. `citedArticleIds` is validated as "a list of
 * strings" here; whether each one is actually among the articles that were
 * offered to the model is a SEPARATE check in `generateAnswer` itself (a
 * schema can't express "must be a subset of this call's own retrieved set"
 * — that's real per-request state, not a fixed shape).
 *
 * N4 real finding (round 2, T-2202, P2): the schema previously accepted
 * ANY string for `answer` — a real `answerable: true` response with an
 * empty string, or one far longer than the prompt's own 300-character
 * instruction, would have been returned to the user as-is. The model's
 * declared shape is untrusted the same way its category/citation claims
 * already are; `answerable: true` paired with an empty or oversized
 * `answer` is treated as a malformed response (rejected here, degrading
 * to escalation), not silently passed through.
 */
const answerGenerationSchema = z
  .object({
    answerable: z.boolean(),
    answer: z.string(),
    citedArticleIds: z.array(z.string()),
  })
  .refine(
    (data) =>
      !data.answerable ||
      (data.answer.trim().length > 0 && data.answer.length <= MAX_ANSWER_LENGTH),
    { message: `answerable 为 true 时 answer 必须非空且不超过 ${MAX_ANSWER_LENGTH} 字符` },
  );

interface RetrievedArticle {
  id: string;
  title: string;
  content: string;
}

function buildAnswerPrompt(userMessage: string, articles: RetrievedArticle[]): string {
  const articlesBlock = articles
    .map(
      (article, index) =>
        `[知识库条目 ${index + 1}] id=${article.id}\n标题：${article.title}\n内容：${article.content}`,
    )
    .join("\n\n");
  return [
    "你是 Agent Market 平台的客服问答助手。你只能依据下面提供的知识库片段回答用户问题，禁止使用片段之外的任何知识，禁止凭空编造平台规则或数字。",
    "如果这些知识库片段实际上不能回答用户的问题，必须如实把 answerable 填为 false，不要勉强给出一个不确定或猜测性的回答。",
    "只输出符合以下 JSON 格式的内容，不要输出任何其他文字：",
    '{"answerable": <true 或 false>, "answer": "<answerable 为 true 时给出不超过300字的中文回答，否则填空字符串 "">, "citedArticleIds": ["<回答中真正依据到的知识库条目 id，必须原样取自上面列出的 id，没有依据到的条目不要列出>"]}',
    "",
    "知识库片段：",
    articlesBlock,
    "",
    `用户问题：${userMessage}`,
  ].join("\n");
}

/** `/api/generate`'s real response envelope — same one-line shape
 * `ai-scorer.ts`/`intent-classifier.ts` each already declare privately;
 * duplicated (not imported) for the same reason `kb-repository.ts`
 * documents for its own duplicated `toVectorLiteral`: a one-line format
 * with no other logic worth sharing across modules. */
const ollamaGenerateEnvelopeSchema = z.object({ response: z.string() });

/**
 * Calls the local Ollama `/api/generate` endpoint to produce an answer
 * grounded ONLY in `articles`. Every failure mode surfaces as
 * `AnswerGenerationError`; `generateAnswer` is the only caller and always
 * catches it.
 */
async function generateGroundedAnswer(
  userMessage: string,
  articles: RetrievedArticle[],
): Promise<{ answerable: boolean; answer: string; citedArticleIds: string[] }> {
  const baseUrl = resolveOllamaBaseUrl();
  const model = resolveAnswerGenerationModel();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildAnswerPrompt(userMessage, articles),
        format: "json",
        stream: false,
        // F-2207: this call's whole purpose is faithful, literal grounding
        // in the retrieved context, never a creative/varied phrasing —
        // `options.temperature: 0` makes Ollama's sampling deterministic
        // (greedy decoding) for this call specifically. Real testing during
        // this Task found the default (unset, Ollama's own sampling
        // temperature) made `answerable` genuinely flip between runs for
        // the SAME question and SAME retrieved context — an
        // honest-uncertainty signal is only trustworthy if it isn't itself
        // a coin flip. Neither `intent-classifier.ts` nor `ai-scorer.ts`
        // set this (a rationale/score has more legitimate phrasing
        // variance), so it isn't blindly copied from them.
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(resolveRequestTimeoutMs()),
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    throw new AnswerGenerationError(
      isTimeout ? "客服回答生成调用超时。" : "客服回答生成调用网络错误。",
      {
        cause: error,
      },
    );
  }

  if (!response.ok) {
    throw new AnswerGenerationError(`客服回答生成服务返回了非成功状态码（${response.status}）。`);
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (error) {
    throw new AnswerGenerationError("客服回答生成服务响应不是合法 JSON。", { cause: error });
  }

  const envelopeParsed = ollamaGenerateEnvelopeSchema.safeParse(rawBody);
  if (!envelopeParsed.success) {
    throw new AnswerGenerationError("客服回答生成服务响应形状不符合预期。", {
      cause: envelopeParsed.error,
    });
  }

  let modelOutput: unknown;
  try {
    modelOutput = JSON.parse(envelopeParsed.data.response);
  } catch (error) {
    throw new AnswerGenerationError("模型输出不是合法 JSON。", { cause: error });
  }

  const parsed = answerGenerationSchema.safeParse(modelOutput);
  if (!parsed.success) {
    throw new AnswerGenerationError("模型输出的回答结构不符合预期。", { cause: parsed.error });
  }

  return parsed.data;
}

/** F-2206/T-2203: how many of the caller's own most-recent tasks are
 * summarized. This module deliberately does NOT attempt to parse which
 * specific task id/title a free-text question refers to (design.md's
 * "范围边界" + this Task's own scope note: NLP-based task-id extraction
 * from free text is a materially bigger, separate concern) — "my most
 * recent task(s)" is the contained, real capability this Task actually
 * builds. A small, fixed number keeps the summary short without needing
 * the 300-character prompt-driven cap that only applies to model output. */
const RECENT_TASK_LIMIT = 3;

/** Chinese labels for `TaskStatusValue` — this module's own presentation
 * concern (the personalized answer's wording), not `tasks` module business
 * knowledge, so it stays private here rather than being pushed onto
 * `tasks/repository.ts`. */
const TASK_STATUS_LABELS: Record<TaskStatusValue, string> = {
  DRAFT: "草稿（尚未发布）",
  AWAITING_FUNDING: "等待资金到账",
  OPEN: "已发布，等待 Agent 接单",
  ACCEPTED: "已被 Agent 接单，进行中",
  SUBMITTED: "Agent 已提交成果，等待验收",
  DISPUTED: "处于争议中",
  RELEASED: "已完成并放款",
  REFUNDED: "已退款",
  CANCELLED: "已取消",
};

function describeTask(task: TaskRow): string {
  const acceptedNote = task.acceptedAgentAddress ? "，已被 Agent 接单" : "，尚未被接单";
  return `《${task.title}》当前状态：${TASK_STATUS_LABELS[task.status]}，交付截止时间：${task.deliveryDeadline.toISOString()}${acceptedNote}。`;
}

/**
 * F-2206/T-2203, Q-2203's decision: a `TASK_STATUS` question from a LOGGED-IN
 * caller is answered from that caller's own real, most-recent task rows —
 * never from anything the free-text `userMessage` itself claims (e.g. "帮我
 * 查一下地址 0xABC... 的任务状态"). `actorAddress` is the ONLY address this
 * function ever uses to scope the lookup; nothing extracted from
 * `userMessage` is ever used as a query parameter, so there is no code path
 * by which a different user's row could be fetched, let alone leaked — this
 * is enforced by construction (the repository call itself is scoped by
 * `actorAddress`), not by trusting a model not to fabricate one.
 *
 * Reuses `tasks/service.ts`'s `listTasksForMarket` — the EXACT existing
 * authorization judgment `GET /tasks` already applies for "am I looking at
 * my own tasks" (Q-2203: "直接复用既有业务模块的权限判断函数...不做任何额外的
 * 跨用户查询能力") — rather than calling `tasks/repository.ts`'s `listTasks`
 * directly and re-deriving that decision here. Passing `requester:
 * normalizedActor` together with `viewerAddress: normalizedActor` makes
 * `listTasksForMarket`'s own `isViewingOwnTasks` check true, which is what
 * lets DRAFT/AWAITING_FUNDING tasks (not just published ones) be included —
 * exactly the same visibility `GET /tasks?requester=<me>` already grants an
 * authenticated caller asking about themselves, no more.
 *
 * Never touches `dispute_evidence_submissions`, credential columns, or any
 * other user's rows — this function has no import of, or call path to,
 * anything beyond `listTasksForMarket`'s own read-only, requester-scoped
 * query.
 *
 * Any failure (invalid `actorAddress` shape, DB error) or zero matching
 * tasks degrades to the same honest escalation result the rest of this
 * module already uses for "nothing to answer with" — never a fabricated
 * task, never an unhandled rejection.
 */
async function personalizedTaskStatusAnswer(
  pool: Queryable,
  actorAddress: string,
): Promise<AnswerGenerationResult> {
  let tasks: TaskRow[];
  try {
    const normalizedActor = normalizeAddress(actorAddress);
    const query = listTasksQuerySchema.parse({
      requester: normalizedActor,
      page: 1,
      pageSize: RECENT_TASK_LIMIT,
    });
    const result = await listTasksForMarket(pool, query, normalizedActor);
    tasks = result.items;
  } catch {
    // F-2210: an invalid actorAddress or a DB failure degrades exactly like
    // every other downstream-service fault in this module.
    return escalationResult("TASK_STATUS");
  }

  if (tasks.length === 0) {
    // Q-2203/design.md: no tasks at all is an honest limitation, not
    // something to fabricate an answer around.
    return escalationResult("TASK_STATUS");
  }

  return {
    intent: "TASK_STATUS",
    answer: ["您最近的任务状态如下：", ...tasks.map(describeTask)].join("\n"),
    citedKbArticleIds: [],
    escalate: false,
  };
}

/**
 * F-2202/F-2203/F-2204/F-2207 end to end. Real flow:
 *
 * 1. `classifyIntent(userMessage)` — also the module's ONLY input-length
 *    gate (see `intent-classifier.ts`'s exported `MAX_USER_MESSAGE_LENGTH`
 *    doc comment): an oversized message throws `IntentClassifierError`
 *    before any network call, which step 1 already treats as an
 *    escalation, so no separate bound is duplicated here.
 * 2. `IntentClassifierError` (any cause) or `intent === "UNHANDLED"` ⇒
 *    escalate immediately. No KB search, no generation call — F-2205's
 *    escalation signal for a not-yet-built T-2204 to consume.
 * 2.5. T-2203/F-2206: `intent === "TASK_STATUS"` AND `actorAddress` is a
 *    logged-in session address ⇒ `personalizedTaskStatusAnswer` answers
 *    directly from the caller's OWN real task rows, never touching the KB
 *    or the generation model at all (there is nothing in `kb_articles`
 *    about a specific user's specific task, and no free-text-driven lookup
 *    should ever reach another user's row). An anonymous caller
 *    (`actorAddress === null`) falls through to step 3/4 instead — a
 *    logged-out visitor asking "my task status" has no task to look up;
 *    that is an honest limitation, not a security bug, and this function
 *    never invents a session to work around it.
 * 3. Otherwise, embed `userMessage` (real `OllamaEmbeddingProvider`) and
 *    retrieve via `searchKbArticles` using the CURRENT embedding version
 *    (computed the same way `seed-kb-articles.ts` does — reusing
 *    `computeEmbeddingVersion`/`resolveVersionIdentity`, never
 *    duplicated). Matches scoring below `SIMILARITY_FLOOR` are dropped.
 * 4. Zero surviving matches (AC-2202's exact scenario) ⇒ the honest
 *    escalation answer, generation is never called — a structural
 *    guarantee, not the model's own choice.
 * 5. Otherwise, a real local Qwen generation call over ONLY the surviving
 *    matches' content, instructed to answer solely from that context and
 *    to say so if it can't. `citedKbArticleIds` is restricted to the
 *    intersection of the model's own claimed `citedArticleIds` and the
 *    real ids that were actually offered to it — a hallucinated id, or a
 *    retrieved-but-unused article, is never surfaced as a citation.
 *
 * F-2210 (fault isolation) applies to EVERY external call this function
 * makes (classification, embedding, KB search, generation, and — since
 * T-2203 — the personalized task lookup) — any failure anywhere in steps
 * 1/2.5/3/5 degrades to the same honest escalation result, never an
 * unhandled rejection.
 */
export async function generateAnswer(
  pool: Queryable,
  userMessage: string,
  /** The current session's actor address, or `null` for an unauthenticated/
   * anonymous chat visitor (T-2203: never fabricated — a caller with no real
   * session must pass `null`, not a placeholder address). */
  actorAddress: string | null,
): Promise<AnswerGenerationResult> {
  let intent: IntentCategory;
  try {
    const classification = await classifyIntent(userMessage);
    intent = classification.intent;
  } catch (error) {
    if (error instanceof IntentClassifierError) {
      return escalationResult("UNHANDLED");
    }
    throw error;
  }

  if (intent === "UNHANDLED") {
    return escalationResult(intent);
  }

  if (intent === "TASK_STATUS" && actorAddress !== null) {
    return personalizedTaskStatusAnswer(pool, actorAddress);
  }

  let relevantArticles: RetrievedArticle[];
  try {
    const provider = new OllamaEmbeddingProvider(pool);
    const identity = await provider.resolveVersionIdentity();
    const embeddingVersion = computeEmbeddingVersion(identity);
    const query = await provider.embed(userMessage);
    const matches = await searchKbArticles(pool, query.vector, embeddingVersion, KB_SEARCH_LIMIT);
    relevantArticles = matches
      .filter((match) => match.similarity >= SIMILARITY_FLOOR)
      .map((match) => ({ id: match.id, title: match.title, content: match.content }));
  } catch {
    // F-2210: embedding-provider failure (unreachable/timeout/budget
    // exhausted/malformed) or a KB search (DB) failure — both are
    // downstream-service faults, degrade the same way a "no relevant
    // knowledge" result does. The specific cause is deliberately not
    // distinguished, matching this module's other callers' "caller never
    // needs to know why" contract.
    return escalationResult(intent);
  }

  if (relevantArticles.length === 0) {
    // AC-2202: no relevant knowledge retrieved ⇒ never even ask the model
    // to answer (design.md: "这是 F-2207 幻觉控制的直接实现手段，不是事后过滤").
    return escalationResult(intent);
  }

  let generated: { answerable: boolean; answer: string; citedArticleIds: string[] };
  try {
    generated = await generateGroundedAnswer(userMessage, relevantArticles);
  } catch {
    // F-2210: a generation failure degrades to the same honest answer as
    // "no relevant knowledge" rather than crashing the caller.
    return escalationResult(intent);
  }

  if (!generated.answerable) {
    // The model's own admission that the retrieved context doesn't
    // actually answer the question — defense-in-depth on top of the
    // structural `SIMILARITY_FLOOR` gate (design.md's Prompt instruction),
    // not a replacement for it. The model's own `answer` text is discarded
    // here, not surfaced, even if it wrote something — an
    // acknowledged-unconfident answer is not a confident one.
    return escalationResult(intent);
  }

  const offeredIds = new Set(relevantArticles.map((article) => article.id));
  const citedKbArticleIds = generated.citedArticleIds.filter((id) => offeredIds.has(id));

  // N4 real finding (round 1, T-2202, P1): the model claiming
  // `answerable: true` is not itself proof of grounding — if every id it
  // cited was hallucinated (not among the articles actually offered) or
  // it cited nothing at all, `citedKbArticleIds` ends up empty here, and
  // surfacing `generated.answer` anyway would be exactly the unsupported,
  // plausible-looking answer F-2207 exists to prevent. An answer with no
  // real citation backing it is treated identically to "not answerable."
  if (citedKbArticleIds.length === 0) {
    return escalationResult(intent);
  }

  return {
    intent,
    answer: generated.answer,
    citedKbArticleIds,
    escalate: false,
  };
}
