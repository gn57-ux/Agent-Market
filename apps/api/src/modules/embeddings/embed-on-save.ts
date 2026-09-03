import type { Queryable } from "../../db/pool.js";
import { OllamaEmbeddingProvider, EmbeddingProviderError } from "./ollama-provider.js";
import type { EmbeddingProvider, EmbeddingResult } from "./provider.js";

// F-1301 (T-1302 clarification — see requirements.md's own inline note):
// Agent-side text is description+category+skillTags (three parts) —
// `expertType` is a Feature 12 task-only field; `agents` has no such
// column, so it cannot appear in the Agent-side concatenation despite the
// original spec wording. Task-side genuinely includes it (four parts).
// Bumped whenever this concatenation formula changes (independent of the
// embedding model/provider identity, which F-1315 now tracks separately
// inside `computeEmbeddingVersion` below) — `agent_embeddings`/
// `task_embeddings` rows carry whichever template version produced them,
// so a future formula change can identify (and, in a later Task,
// re-embed) rows computed under an old formula.
const EMBEDDING_TEXT_TEMPLATE_VERSION = "v1";

/**
 * F-1315: `embedding_version` must record provider + model tag + Ollama
 * model digest + dimension + text-template version — not just a bare
 * template-version string (T-1308's rework; the pre-Ollama column only
 * ever stored `EMBEDDING_TEXT_VERSION` verbatim, conflating "how the input
 * text was built" with "which model produced the vector"). A mutable tag
 * like `bge-m3:latest` alone can't distinguish two different sets of
 * weights served under the same tag after a local `ollama pull` — the
 * digest can. Composed here (not in ollama-provider.ts) because this is
 * the one place that knows both halves: the Provider-derived identity
 * (`result.provider`/`result.model`/`result.modelDigest`/
 * `result.dimension`) and this module's own text-template version.
 */
export function computeEmbeddingVersion(
  result: Pick<EmbeddingResult, "provider" | "model" | "modelDigest" | "dimension">,
): string {
  return `${result.provider}:${result.model}@${result.modelDigest}:dim${result.dimension}:tmpl${EMBEDDING_TEXT_TEMPLATE_VERSION}`;
}

/** Exported (T-1307 v2): the golden-sample calibration test needs the
 * EXACT same text-building rule production writes with — reimplementing
 * an independent copy would risk silently drifting from what actually
 * gets embedded and stored (CLAUDE.md 原则 6: 设计知识只能有一个归属). */
export function buildAgentEmbeddingText(agent: {
  description: string;
  category: string;
  skillTags: string[];
}): string {
  return [
    agent.description,
    `分类：${agent.category}`,
    `技能标签：${agent.skillTags.join(", ")}`,
  ].join("\n");
}

/** Exported (T-1307 v2): see `buildAgentEmbeddingText`'s identical note. */
export function buildTaskEmbeddingText(task: {
  description: string;
  expertType: string;
  category: string;
  skillTags: string[];
}): string {
  return [
    task.description,
    `专家类型：${task.expertType}`,
    `分类：${task.category}`,
    `技能标签：${task.skillTags.join(", ")}`,
  ].join("\n");
}

/** pgvector's textual input format for a `vector(N)` column — a bracketed,
 * comma-separated list of numbers. `node-pg` has no built-in pgvector
 * binding (this project didn't add the `pgvector` npm package, matching
 * design.md's "不引入新基础设施" stance beyond the extension itself), so
 * this is the one place a `number[]` becomes the literal text Postgres
 * parses into that column type. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Constructs the one `EmbeddingProvider` this module uses, or `null` if
 * none is available (`EMBEDDING_PROVIDER=off`, or an undeclared
 * `OLLAMA_EMBEDDING_MODEL` — the "一个环境变量即可整体禁用向量召回" kill
 * switch requirements.md's non-functional section requires). Only the
 * literal `"off"` disables — unset (or `"ollama"`) attempts the real
 * Provider, mirroring the old OpenAI Provider's default polarity, so local
 * dev works with zero extra config as long as Ollama is genuinely running
 * (F-1314). Never throws — `OllamaEmbeddingProvider`'s constructor throws
 * for an undeclared model (F-1302's "构造即报告不可用" contract, aimed at
 * callers who WANT that failure loud, e.g. a future healthcheck), but this
 * caller wants exactly the opposite: F-1304's degrade-path treats "no
 * Provider available" as just another reason to skip embedding, not a
 * reason to fail the save that triggered this call. Deliberately never
 * falls back to a different Provider — F-1304: different models' vector
 * spaces aren't compatible, so the only degrade target is v0.1's category
 * match on the read side, never a silent Provider switch here.
 */
function resolveProvider(pool: Queryable): EmbeddingProvider | null {
  if (process.env.EMBEDDING_PROVIDER === "off") {
    return null;
  }
  try {
    return new OllamaEmbeddingProvider(pool);
  } catch (error) {
    if (error instanceof EmbeddingProviderError) {
      return null;
    }
    throw error;
  }
}

/**
 * Runs `work` only after every previously enqueued `work` for the same
 * `key` has settled — the fix for T-1302's N4 round-1 Finding 2: without
 * this, two concurrent saves of the same entity race their outbound
 * Embedding Provider HTTP calls, and whichever response arrives LAST wins
 * the UPSERT regardless of which save actually happened more recently (an
 * older save's slow response can silently overwrite a newer save's
 * embedding with stale data). Serializing by invocation order — not
 * response order — guarantees the UPSERT that runs last corresponds to the
 * save that was triggered last, since `embedAgentOnSave`/`embedTaskOnSave`
 * are invoked synchronously from the route handler at the moment each save
 * commits, so invocation order already reflects save recency. The queue
 * entry is dropped once drained so this map never holds more entries than
 * there are entities with an in-flight embedding call at any instant.
 *
 * T-1308 N4 P2 fix: `previous` may itself be a REJECTED promise (an
 * earlier call's `work` threw — e.g. `deleteAgentEmbedding` hit a
 * transient DB error, which isn't wrapped in its own try/catch by
 * design, see `embedAgentOnSave`'s doc comment). Chaining `.then(work)`
 * directly off a rejected `previous` would skip `work` entirely and just
 * re-reject — jamming EVERY subsequent save for that entity after a
 * single transient failure, since each new call's `previous` is the
 * still-rejected prior `next`. `.catch(() => {})` absorbs a prior call's
 * outcome before chaining `work`, so this call's own success/failure is
 * the only thing `next` ever reflects. Separately, the cleanup step is
 * now a distinct `.catch(() => {}).finally(...)` chain off `next` (never
 * itself rejects) rather than a bare `void next.finally(...)` — the
 * bare form creates its own new derived promise via `.finally()` that,
 * if `next` rejects, is a SEPARATE unhandled rejection from `next`'s own
 * (already-handled-by-the-caller) one; Node tracks each promise object
 * independently; `next` itself is still returned unchanged, so its
 * rejection continues to propagate normally to whichever caller
 * awaits/catches this function's return value.
 */
function enqueuePerEntity(
  queues: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<void>,
): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(key, next);
  next
    .catch(() => {})
    .finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    });
  return next;
}

// Separate queues: Agent ids and Task ids are unrelated entities, so a
// shared queue would serialize an Agent save behind an unrelated Task save
// for no reason.
const agentEmbedQueues = new Map<string, Promise<void>>();
const taskEmbedQueues = new Map<string, Promise<void>>();

/**
 * N4 round-2 Finding: deletes an entity's existing embedding row BEFORE a
 * regeneration attempt, not after a successful one — so a failed
 * regeneration (Provider down, timeout, budget exhausted, malformed
 * response; every cause F-1303 lists) leaves no row behind. F-1304's
 * degrade path is defined as "缺少有效向量...退回分类精确匹配"; a
 * left-over vector computed from the entity's PRIOR text would satisfy
 * that "row exists" check while actually describing stale content —
 * silently wrong, not merely absent. Eager deletion trades a strictly
 * short availability gap (a working vector momentarily disappears during
 * every regeneration, not only failing ones) for the simpler, spec-literal
 * guarantee that a row's mere existence always means "current text,
 * successfully embedded" with no separate staleness check required
 * anywhere that reads these tables.
 */
async function deleteAgentEmbedding(pool: Queryable, agentId: string): Promise<void> {
  await pool.query(`DELETE FROM agent_embeddings WHERE agent_id = $1`, [agentId]);
}

/** Same contract as `deleteAgentEmbedding`, for a task. */
async function deleteTaskEmbedding(pool: Queryable, taskId: string): Promise<void> {
  await pool.query(`DELETE FROM task_embeddings WHERE task_id = $1`, [taskId]);
}

async function upsertAgentEmbedding(
  pool: Queryable,
  agentId: string,
  result: EmbeddingResult,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (agent_id) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       dimension = EXCLUDED.dimension,
       embedding_version = EXCLUDED.embedding_version,
       generated_at = now()`,
    [
      agentId,
      toVectorLiteral(result.vector),
      result.provider,
      result.model,
      result.dimension,
      computeEmbeddingVersion(result),
    ],
  );
}

async function upsertTaskEmbedding(
  pool: Queryable,
  taskId: string,
  result: EmbeddingResult,
): Promise<void> {
  await pool.query(
    `INSERT INTO task_embeddings (task_id, embedding, provider, model, dimension, embedding_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (task_id) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       dimension = EXCLUDED.dimension,
       embedding_version = EXCLUDED.embedding_version,
       generated_at = now()`,
    [
      taskId,
      toVectorLiteral(result.vector),
      result.provider,
      result.model,
      result.dimension,
      computeEmbeddingVersion(result),
    ],
  );
}

/**
 * F-1301/F-1303/F-1304: generates and persists (or refreshes) an Agent's
 * embedding after a successful create/update. Fire-and-forget by design —
 * every caller (routes.ts) invokes this WITHOUT awaiting it before sending
 * the HTTP response, and every failure this function can experience
 * (Provider unavailable, timeout, rate limit, budget exhausted, a
 * malformed response) is caught here and never rethrown — "绝不让保存 Agent/
 * 任务这一操作因为 Embedding 生成失败而整体失败" is enforced by this
 * function's own contract, not by caller discipline. Exactly one `embed()`
 * attempt per call, no retry (F-1303's "最多触发一次（不重试）"). Concurrent
 * calls for the same Agent are serialized via `enqueuePerEntity` so an
 * older save's slower response can never overwrite a newer save's result.
 * Any existing vector is deleted before the new attempt starts (see
 * `deleteAgentEmbedding`'s doc comment) — a failed attempt leaves no row,
 * so F-1304's downstream consumers never need a separate staleness check.
 */
export async function embedAgentOnSave(
  pool: Queryable,
  agent: { id: string; description: string; category: string; skillTags: string[] },
  /** Test seam, AND (T-1310) a real production reuse point:
   * `scripts/backfill-embeddings.ts` passes its own single, already-
   * constructed `OllamaEmbeddingProvider` instance here across many
   * entities in one run, so its digest lookup (`resolveVersionIdentity`)
   * is paid once, not once per entity. `agents/routes.ts`/`tasks/routes.ts`
   * still never pass this, always getting `resolveProvider`'s real
   * env-driven resolution per call. `OllamaEmbeddingProvider` has no way
   * to redirect its request URL from outside a fresh construction, so
   * tests that need to prove the success/failure paths against a real
   * local server inject a provider built with that same seam. */
  providerOverride?: EmbeddingProvider,
): Promise<void> {
  const provider = providerOverride ?? resolveProvider(pool);
  // Codex review (T-1308 P2): the no-provider check used to return BEFORE
  // even entering the per-entity queue, skipping `deleteAgentEmbedding`
  // entirely. If this Agent already had a vector and its text just
  // changed, that early return left the OLD vector in place — looking
  // "valid" (row exists) to dispatch/repository.ts's semantic recall while
  // actually describing stale content, violating this file's own
  // "row exists ⇒ current text" invariant (see `deleteAgentEmbedding`'s
  // doc comment). Moving both the delete AND the no-provider check inside
  // the queued work fixes that, AND closes a second latent ordering gap:
  // previously a "no provider" call bypassed `enqueuePerEntity` entirely,
  // so it could race a slower in-flight regeneration for the same entity
  // outside the FIFO ordering the queue exists to guarantee.
  await enqueuePerEntity(agentEmbedQueues, agent.id, async () => {
    await deleteAgentEmbedding(pool, agent.id);
    if (!provider) {
      return;
    }
    try {
      const result = await provider.embed(buildAgentEmbeddingText(agent));
      await upsertAgentEmbedding(pool, agent.id, result);
    } catch {
      // F-1301: logged only (via the caller's own request-scoped logger in
      // a real deployment; this module has no logger dependency of its
      // own), never rethrown. The specific reason (timeout vs. budget vs.
      // malformed response) is deliberately not distinguished here —
      // provider.ts's own contract is that every failure mode is
      // equivalent from a caller's perspective.
    }
  });
}

/** Same contract as `embedAgentOnSave`, for a task's create/update. */
export async function embedTaskOnSave(
  pool: Queryable,
  task: {
    id: string;
    description: string;
    expertType: string;
    category: string;
    skillTags: string[];
  },
  /** Test seam only — see `embedAgentOnSave`'s identical parameter. */
  providerOverride?: EmbeddingProvider,
): Promise<void> {
  const provider = providerOverride ?? resolveProvider(pool);
  // See embedAgentOnSave's identical comment (T-1308 P2 fix).
  await enqueuePerEntity(taskEmbedQueues, task.id, async () => {
    await deleteTaskEmbedding(pool, task.id);
    if (!provider) {
      return;
    }
    try {
      const result = await provider.embed(buildTaskEmbeddingText(task));
      await upsertTaskEmbedding(pool, task.id, result);
    } catch {
      // See embedAgentOnSave's identical comment.
    }
  });
}
