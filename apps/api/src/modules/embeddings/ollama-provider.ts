import type { Queryable } from "../../db/pool.js";
import { tryConsumeEmbeddingBudget } from "./budget.js";
import type { EmbeddingProvider, EmbeddingResult } from "./provider.js";

// F-1314: the sole place a supported model's dimension is declared. No env
// var may override a model's dimension — `OLLAMA_EMBEDDING_MODEL` only
// selects WHICH declared model to use; a tag absent from this table is a
// local configuration error (thrown at construction), not a runtime
// Provider failure. `bge-m3:latest` is the only model this Feature
// verified end-to-end (real local `curl` calls against a running Ollama
// during the T-1308 design pass) — adding another model here is a future
// decision, not something this module infers from Ollama's own responses.
const OLLAMA_MODEL_DESCRIPTIONS: Record<string, { dimension: number }> = {
  "bge-m3:latest": { dimension: 1024 },
};

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "bge-m3:latest";

// Real local `/api/embed` calls for this Feature's short Agent/task
// description text complete in well under a second (verified against a
// real running Ollama). 15s (F-1314's explicit requirement, longer than
// openai-provider.ts's old 10s) leaves headroom for a cold model load on a
// machine under load, while still failing fast enough that a save event
// isn't blocked indefinitely.
const REQUEST_TIMEOUT_MS = 15_000;

export function resolveOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
}

export function resolveOllamaEmbeddingModel(): string {
  return process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_EMBEDDING_MODEL;
}

/**
 * Thrown for every `embed()` failure mode (Ollama unreachable, model not
 * installed, budget exhausted, timeout, non-2xx response, malformed
 * response body) — provider.ts's own contract is that callers never need
 * to distinguish "why," only "it failed." The message never includes raw
 * request text or a full response body (F-1314's logging constraint);
 * the real cause (if any) is attached via `cause` for server-side
 * log-only inspection.
 */
export class EmbeddingProviderError extends Error {}

/**
 * F-1302/F-1308's one `EmbeddingProvider` implementation: local Ollama,
 * `bge-m3:latest`. The model tag is validated against
 * `OLLAMA_MODEL_DESCRIPTIONS` once, at construction — an undeclared model
 * is a configuration mistake that should fail loudly and immediately,
 * mirroring `OpenAiEmbeddingProvider`'s old "构造即报告不可用" contract for
 * its equivalent local check (a missing API key). Unlike that old check,
 * WHETHER Ollama is actually reachable is a network concern the
 * constructor deliberately does NOT probe — same reasoning as the old
 * Provider never verifying its API key was valid at construction, only
 * that one was present; reachability failures surface from `embed()`,
 * where every other runtime failure mode already surfaces.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly pool: Queryable;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimension: number;
  private readonly timeoutMs: number;
  // Ollama's model digest never changes during a single process's
  // lifetime (a `ollama pull` that updates the tag would require a
  // process restart to pick up local config changes anyway, matching
  // this codebase's established "env-derived config read at call time,
  // but a network-derived fact cached for the instance's life" split) —
  // cached after the first successful lookup so a normal `embed()` call
  // only ever makes one HTTP request, not two.
  private cachedDigest: string | undefined;

  constructor(
    pool: Queryable,
    options: {
      /** Test seam only — production callers never pass this, always
       * getting the real local Ollama endpoint. */
      baseUrl?: string;
      /** Test seam only — production callers never pass this, always
       * getting `resolveOllamaEmbeddingModel()`'s real env-driven value. */
      model?: string;
      /** Test seam only — see openai-provider.ts's identical `timeoutMs`
       * option (now removed) for why: a real timeout test needs a real
       * (short) clock delay, not a mocked one. */
      timeoutMs?: number;
    } = {},
  ) {
    const model = options.model ?? resolveOllamaEmbeddingModel();
    const description = OLLAMA_MODEL_DESCRIPTIONS[model];
    if (!description) {
      throw new EmbeddingProviderError(
        `未声明的 Ollama Embedding 模型：${model}（模型描述表中没有对应维度，见 F-1314）。`,
      );
    }
    this.pool = pool;
    this.baseUrl = options.baseUrl ?? resolveOllamaBaseUrl();
    this.model = model;
    this.dimension = description.dimension;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async resolveModelDigest(): Promise<string> {
    if (this.cachedDigest) {
      return this.cachedDigest;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
      throw new EmbeddingProviderError(
        isTimeout ? "Ollama 模型列表查询超时。" : "无法连接本机 Ollama。",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new EmbeddingProviderError(
        `Ollama 模型列表查询返回了非成功状态码（${response.status}）。`,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (error) {
      throw new EmbeddingProviderError("Ollama 模型列表响应不是合法 JSON。", { cause: error });
    }

    const digest = extractModelDigest(rawBody, this.model);
    if (!digest) {
      throw new EmbeddingProviderError(`本机 Ollama 未安装模型：${this.model}`);
    }
    this.cachedDigest = digest;
    return digest;
  }

  /**
   * T-1310: resolves the identity fields `embedding_version` is composed
   * from (see `embed-on-save.ts`'s `computeEmbeddingVersion`) WITHOUT
   * performing a full `embed()` call — the backfill script needs this to
   * decide which rows are stale/missing BEFORE spending any real Ollama
   * inference budget on entities that turn out to already be current.
   * Reuses `resolveModelDigest`'s own caching, so this costs one real
   * `/api/tags` request at most once per instance, same as `embed()`
   * already does internally.
   */
  async resolveVersionIdentity(): Promise<{
    provider: string;
    model: string;
    modelDigest: string;
    dimension: number;
  }> {
    const digest = await this.resolveModelDigest();
    return {
      provider: "ollama",
      model: this.model,
      modelDigest: digest,
      dimension: this.dimension,
    };
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const withinBudget = await tryConsumeEmbeddingBudget(this.pool);
    if (!withinBudget) {
      throw new EmbeddingProviderError("本月 Embedding 调用预算已耗尽。");
    }

    const digest = await this.resolveModelDigest();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
      throw new EmbeddingProviderError(
        isTimeout ? "Embedding 调用超时。" : "Embedding 调用网络错误。",
        { cause: error },
      );
    }

    if (!response.ok) {
      // Never include the response body in the thrown message — mirrors
      // openai-provider.ts's identical defense-in-depth rule.
      throw new EmbeddingProviderError(
        `Embedding Provider 返回了非成功状态码（${response.status}）。`,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (error) {
      throw new EmbeddingProviderError("Embedding Provider 响应不是合法 JSON。", {
        cause: error,
      });
    }

    const vector = extractEmbeddingVector(rawBody, this.dimension);
    if (!vector) {
      // F-1314's runtime-validation requirement: HTTP success alone is not
      // enough — `embeddings[0]` must exist, be exactly `this.dimension`
      // long, and every element must be a finite number. A shape mismatch
      // here must become a normal EmbeddingProviderError, not an unwrapped
      // TypeError from property access on an unexpected value (same
      // trust-boundary reasoning as openai-provider.ts's identical check).
      throw new EmbeddingProviderError(
        `Embedding Provider 响应形状不是预期的 ${this.dimension} 维向量。`,
      );
    }

    return {
      vector,
      model: this.model,
      dimension: this.dimension,
      provider: "ollama",
      modelDigest: digest,
    };
  }
}

/**
 * Runtime-validates an unknown JSON value against `GET /api/tags`'s real
 * shape (`{ models: [{ name, digest, ... }] }`) and returns the digest for
 * the entry whose `name` matches `model`, or `null` if the list doesn't
 * parse or contains no matching entry. Never throws itself, matching
 * `extractEmbeddingVector`'s identical discipline.
 */
function extractModelDigest(body: unknown, model: string): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return null;
  }
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const name = (entry as { name?: unknown }).name;
    if (name !== model) {
      continue;
    }
    const digest = (entry as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.length > 0) {
      return digest;
    }
  }
  return null;
}

/**
 * Runtime-validates an unknown JSON value against `POST /api/embed`'s real
 * shape (`{ embeddings: [[...]] }`, with the first element being exactly
 * `dimension` finite numbers) — returns the vector on success, `null` on
 * any shape mismatch. Never throws itself, mirroring
 * openai-provider.ts's `extractEmbeddingVector`.
 */
function extractEmbeddingVector(body: unknown, dimension: number): number[] | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const embeddings = (body as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    return null;
  }
  const vector = embeddings[0];
  if (!Array.isArray(vector) || vector.length !== dimension) {
    return null;
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  return vector;
}
