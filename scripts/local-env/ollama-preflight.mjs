// Feature 13 (vector-recall-scoring), T-1311 (F-1317).
//
// Read-only Ollama/bge-m3 preflight for env:start/env:status — checks
// `GET {OLLAMA_BASE_URL}/api/tags` is reachable and that the configured
// `OLLAMA_EMBEDDING_MODEL` is actually installed. Deliberately does NOT
// install, pull, start, or stop Ollama, and never sets `process.exitCode`
// — F-1304 already defines "no usable Embedding Provider" as a normal
// degrade state the rest of the platform tolerates (falls back to v0.1
// category matching), not an "environment failed to start" condition, so
// this check's own failure can't be either. Not added to manifest.mjs's
// process list — Ollama isn't a process this tool spawns, tracks, or
// stops; it only ever reads Ollama's current state.
//
// Defaults mirror apps/api/src/modules/embeddings/ollama-provider.ts's own
// `resolveOllamaBaseUrl`/`resolveOllamaEmbeddingModel` (duplicated here,
// not imported — this is a plain .mjs script with no build step, and
// apps/api's TS module isn't something a script outside that package
// should reach into; the two independently reading the SAME env var names
// with the SAME defaults is the actual single source of truth, an env var
// contract, not code).
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "bge-m3:latest";

function resolveOllamaBaseUrl() {
  return process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
}

function resolveOllamaEmbeddingModel() {
  return process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_EMBEDDING_MODEL;
}

/**
 * Pure check — returns a result object, never prints anything itself (this
 * project's established local-env convention: checks return data, callers
 * decide how to log it, matching ports.mjs/chain-fingerprint.mjs). Never
 * throws: every failure mode (unreachable, non-2xx, malformed body, model
 * absent) becomes `{ ok: false, reason }`.
 */
export async function checkOllamaEmbedding({ timeoutMs = 3000 } = {}) {
  const baseUrl = resolveOllamaBaseUrl();
  const model = resolveOllamaEmbeddingModel();

  let response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, baseUrl, model, reason: `无法连接本机 Ollama（${error.message}）。` };
  }

  if (!response.ok) {
    return {
      ok: false,
      baseUrl,
      model,
      reason: `Ollama 返回了非成功状态码（${response.status}）。`,
    };
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, baseUrl, model, reason: `Ollama 响应不是合法 JSON（${error.message}）。` };
  }

  const models = Array.isArray(body?.models) ? body.models : [];
  const installed = models.some((entry) => entry?.name === model);
  if (!installed) {
    return { ok: false, baseUrl, model, reason: `Ollama 可达，但未安装模型 ${model}。` };
  }

  return { ok: true, baseUrl, model };
}

/** Formats `checkOllamaEmbedding`'s result as the Chinese-language lines
 * F-1317 requires, via the caller's own `log` function (start.mjs prefixes
 * with `[env:start]`; status.mjs's `console.log` has no such prefix — this
 * stays agnostic to either). */
export function formatOllamaPreflightLines(result) {
  if (result.ok) {
    return [`✅ Ollama Embedding 就绪：${result.baseUrl}，模型 ${result.model} 已安装。`];
  }
  return [
    `⚠️ Ollama Embedding 不可用：${result.reason}`,
    `   提示：确认本机 Ollama 已启动（ollama serve），并已拉取模型（ollama pull ${result.model}）。`,
    "   这不会阻止环境启动，也不视为异常——语义召回会自动降级为 v0.1 分类匹配（F-1304）。",
  ];
}
