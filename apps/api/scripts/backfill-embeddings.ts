// Feature 13 (vector-recall-scoring), T-1310 (F-1316).
//
// Idempotent backfill: (re-)generates `agent_embeddings`/`task_embeddings`
// rows for every Agent/task whose current row is missing or whose stored
// `embedding_version` doesn't match what the ACTIVE configuration would
// produce right now (a stale row from a superseded model/digest/template
// version). Reuses `embed-on-save.ts`'s already-tested `embedAgentOnSave`/
// `embedTaskOnSave` pipeline verbatim (text concatenation, delete-before-
// regenerate, per-entity serialization, uniform failure handling all
// included) — this script's only real job is deciding WHICH entities need
// that pipeline run, not reimplementing any part of it.
//
// Run as `pnpm --filter @agent-market/api backfill-embeddings` (see
// package.json). Deliberately a standalone script, never invoked from a
// migration file — migrations are transactional DDL; a batch of real
// network calls to Ollama does not belong in that failure domain
// (design.md's explicit constraint).
//
// Naturally idempotent and resumable: every run re-queries current
// database state and only processes rows that are STILL missing/stale, so
// interrupting this script (crash, kill, Ctrl-C) and re-running it later
// picks up exactly where it left off — no separate "already processed"
// tracking table is needed.
//
// `runBackfill` is exported (not just called from `main`) so
// backfill-embeddings.integration.test.ts can exercise the real logic
// directly against a real Postgres pool and a real (fake-server-backed)
// Provider, matching this codebase's established "test through the real
// function, not a subprocess" convention (db/migrate.ts's `runMigrations`
// is the precedent this mirrors).
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import {
  computeEmbeddingVersion,
  embedAgentOnSave,
  embedTaskOnSave,
} from "../src/modules/embeddings/embed-on-save.js";
import { OllamaEmbeddingProvider } from "../src/modules/embeddings/ollama-provider.js";

// F-1316's explicit "并发上限 1-2" — a small, fixed cap protecting the
// local Ollama process from a large backfill batch overwhelming it (the
// same "本机资源保护" concern `tryConsumeEmbeddingBudget` already
// addresses per-call; this bounds how many calls are ever in flight at
// once). Not user-configurable — this is a resource-protection ceiling,
// not a tuning knob.
const CONCURRENCY = 2;

interface AgentIdRow {
  id: string;
  embedding_version: string | null;
}

interface TaskIdRow {
  id: string;
  embedding_version: string | null;
}

interface AgentText {
  id: string;
  description: string;
  category: string;
  skillTags: string[];
  /** Captured alongside the text this instance read — see
   * `embedAgentUntilStable`'s doc comment for why this is needed. */
  updatedAt: Date;
}

interface TaskText {
  id: string;
  description: string;
  expertType: string;
  category: string;
  skillTags: string[];
  updatedAt: Date;
}

export interface BackfillSummary {
  targetVersion: string;
  agentsProcessed: number;
  tasksProcessed: number;
  remainingStaleAgents: number;
  remainingStaleTasks: number;
}

/** Runs `worker` over `items` with at most `limit` concurrently in flight —
 * the "simple semaphore, no queue infrastructure" F-1316 asks for. Isolates
 * each `worker` call's own failure (see the try/catch below) so one
 * entity's error never stops the rest from being attempted — matching
 * design.md's "某条失败只记录并继续下一条,不中断整体运行". */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const currentIndex = nextIndex;
    nextIndex += 1;
    if (currentIndex >= items.length) {
      return;
    }
    try {
      await worker(items[currentIndex] as T);
    } catch (error) {
      // Codex review (T-1311 P2): `worker` isn't guaranteed never to
      // throw (a transient DB error inside `fetchAgentText`/
      // `embedAgentOnSave`'s own un-caught `deleteAgentEmbedding` call/
      // `readAgentUpdatedAt` all propagate) — without this, one item's
      // failure would reject this whole `Promise.all`, abandoning every
      // item not yet claimed and tearing down the pool mid-batch,
      // contradicting this script's own documented "某条失败只记录并继续
      // 下一条,不中断整体运行" contract (design.md/F-1316). Logged, not
      // rethrown; the failed item simply stays missing/stale for the next
      // backfill run to retry — no separate tracking needed, same as any
      // other failure mode this script already treats this way.
      console.error(
        `  ⚠️ 处理第 ${currentIndex + 1} 项时出错，已跳过：${(error as Error).message}`,
      );
    }
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
}

async function fetchAgentIdRows(pool: Pool): Promise<AgentIdRow[]> {
  // Ordered by creation time — without an explicit ORDER BY, Postgres
  // gives no ordering guarantee at all, which would make a run's
  // processing order (and this script's own log output) arbitrary and
  // non-reproducible between runs against the same data.
  const { rows } = await pool.query<AgentIdRow>(`
    SELECT a.id, ae.embedding_version
    FROM agents a
    LEFT JOIN agent_embeddings ae ON ae.agent_id = a.id
    ORDER BY a.created_at
  `);
  return rows;
}

async function fetchTaskIdRows(pool: Pool): Promise<TaskIdRow[]> {
  const { rows } = await pool.query<TaskIdRow>(`
    SELECT t.id, te.embedding_version
    FROM tasks t
    LEFT JOIN task_embeddings te ON te.task_id = t.id
    ORDER BY t.created_at
  `);
  return rows;
}

/**
 * Fetches ONE Agent's current text, or `null` if it no longer exists.
 * Deliberately called per-entity, immediately before `embedAgentOnSave`,
 * rather than reusing a batch-wide snapshot (Codex review, T-1310 P2): a
 * batch snapshot taken up front stays fixed while the rest of the batch is
 * still being processed (real network round trips to Ollama, one entity at
 * a time under `CONCURRENCY`), so a real concurrent save landing in that
 * window would have its fresh text silently overwritten by this script's
 * STALE snapshot — and, worse, tagged with the same "current"
 * `embedding_version`, so no future backfill run would ever detect or fix
 * it either. Re-reading right before use shrinks that window back down to
 * the same single-round-trip size every other `embedAgentOnSave` caller
 * already has (embed-on-save.ts's own accepted race tolerance), rather
 * than accumulating across an entire batch.
 */
async function fetchAgentText(pool: Pool, id: string): Promise<AgentText | null> {
  const { rows } = await pool.query<{
    id: string;
    description: string;
    category: string;
    skill_tags: string[];
    updated_at: Date;
  }>(
    `SELECT a.id, a.description, a.category, a.updated_at,
       COALESCE(array_agg(DISTINCT s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL), '{}') AS skill_tags
     FROM agents a
     LEFT JOIN agent_skills s ON s.agent_id = a.id
     WHERE a.id = $1
     GROUP BY a.id`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    description: row.description,
    category: row.category,
    skillTags: row.skill_tags,
    updatedAt: row.updated_at,
  };
}

/** Same contract as `fetchAgentText`, for a task. */
async function fetchTaskText(pool: Pool, id: string): Promise<TaskText | null> {
  const { rows } = await pool.query<{
    id: string;
    description: string;
    expert_type: string;
    category: string;
    skill_tags: string[];
    updated_at: Date;
  }>(
    `SELECT t.id, t.description, t.expert_type, t.category, t.updated_at,
       COALESCE(array_agg(DISTINCT s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL), '{}') AS skill_tags
     FROM tasks t
     LEFT JOIN task_skills s ON s.task_id = t.id
     WHERE t.id = $1
     GROUP BY t.id`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    description: row.description,
    expertType: row.expert_type,
    category: row.category,
    skillTags: row.skill_tags,
    updatedAt: row.updated_at,
  };
}

async function readAgentUpdatedAt(pool: Pool, id: string): Promise<Date | null> {
  const { rows } = await pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM agents WHERE id = $1`,
    [id],
  );
  return rows[0]?.updated_at ?? null;
}

async function readTaskUpdatedAt(pool: Pool, id: string): Promise<Date | null> {
  const { rows } = await pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM tasks WHERE id = $1`,
    [id],
  );
  return rows[0]?.updated_at ?? null;
}

// F-1316's "并发上限 1-2" already bounds how much concurrent write pressure
// a single entity can plausibly see; this cap is for a DIFFERENT purpose —
// how many times THIS script will re-embed the SAME entity if it keeps
// getting updated out from under it — a small, fixed ceiling so a entity
// under genuinely sustained concurrent writes doesn't loop indefinitely.
const MAX_STABILIZE_ATTEMPTS = 3;

/**
 * Codex review (T-1311 P1, correcting a flawed P2 fix from the previous
 * round): the earlier design re-read `updated_at` after writing and
 * DELETED the embedding row on any mismatch, reasoning "if it changed, my
 * write might be stale." That reasoning had a real gap: by the time this
 * check runs, the row it deletes might NOT be this script's own (possibly
 * stale) write at all — a concurrent save's OWN `embedAgentOnSave` call
 * could have already run and overwritten it with the CORRECT, fresh
 * vector, and the unconditional DELETE would destroy that correct data
 * just because `updated_at` also happens to differ from what this script
 * originally observed.
 *
 * The actual invariant needed isn't "delete if changed" — it's "keep
 * re-embedding with fresh text until a check confirms the entity didn't
 * change during that specific attempt's own read-to-write window." This
 * never deletes anything (deleting risks destroying a correct concurrent
 * write, as above); on exhausting `MAX_STABILIZE_ATTEMPTS` under sustained
 * concurrent writes, it simply stops and leaves whatever is there —
 * matching this module's own "一个环境变量即可整体禁用" spirit of never
 * making an already-imperfect situation actively worse. A future backfill
 * run, or the entity's own next real save, converges it correctly.
 */
async function embedAgentUntilStable(
  pool: Pool,
  provider: OllamaEmbeddingProvider,
  id: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_STABILIZE_ATTEMPTS; attempt += 1) {
    const agent = await fetchAgentText(pool, id);
    if (!agent) {
      return;
    }
    await embedAgentOnSave(pool, agent, provider);
    const currentUpdatedAt = await readAgentUpdatedAt(pool, id);
    if (!currentUpdatedAt || currentUpdatedAt.getTime() === agent.updatedAt.getTime()) {
      return;
    }
  }
}

/** Same contract as `embedAgentUntilStable`, for a task. */
async function embedTaskUntilStable(
  pool: Pool,
  provider: OllamaEmbeddingProvider,
  id: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_STABILIZE_ATTEMPTS; attempt += 1) {
    const task = await fetchTaskText(pool, id);
    if (!task) {
      return;
    }
    await embedTaskOnSave(pool, task, provider);
    const currentUpdatedAt = await readTaskUpdatedAt(pool, id);
    if (!currentUpdatedAt || currentUpdatedAt.getTime() === task.updatedAt.getTime()) {
      return;
    }
  }
}

/**
 * Core backfill logic, given an already-resolved `pool`/`provider`. Queries
 * current state, runs the reused save pipeline (bounded by `CONCURRENCY`)
 * for every entity missing a row or holding a stale `embedding_version`,
 * then re-queries to report what — if anything — is still incomplete
 * (`embedAgentOnSave`/`embedTaskOnSave` never surface per-entity
 * success/failure themselves; a re-run naturally retries exactly these
 * remaining rows, so no separate tracking is needed).
 */
export async function runBackfill(
  pool: Pool,
  provider: OllamaEmbeddingProvider,
): Promise<BackfillSummary> {
  const targetVersion = computeEmbeddingVersion(await provider.resolveVersionIdentity());

  const agentIdRows = await fetchAgentIdRows(pool);
  const agentIdsNeedingBackfill = agentIdRows
    .filter((row) => row.embedding_version !== targetVersion)
    .map((row) => row.id);
  await runWithConcurrency(agentIdsNeedingBackfill, CONCURRENCY, async (id) => {
    await embedAgentUntilStable(pool, provider, id);
  });

  const taskIdRows = await fetchTaskIdRows(pool);
  const taskIdsNeedingBackfill = taskIdRows
    .filter((row) => row.embedding_version !== targetVersion)
    .map((row) => row.id);
  await runWithConcurrency(taskIdsNeedingBackfill, CONCURRENCY, async (id) => {
    await embedTaskUntilStable(pool, provider, id);
  });

  const [remainingAgents, remainingTasks] = await Promise.all([
    fetchAgentIdRows(pool),
    fetchTaskIdRows(pool),
  ]);

  return {
    targetVersion,
    agentsProcessed: agentIdsNeedingBackfill.length,
    tasksProcessed: taskIdsNeedingBackfill.length,
    remainingStaleAgents: remainingAgents.filter((row) => row.embedding_version !== targetVersion)
      .length,
    remainingStaleTasks: remainingTasks.filter((row) => row.embedding_version !== targetVersion)
      .length,
  };
}

async function main(): Promise<void> {
  if (process.env.EMBEDDING_PROVIDER === "off") {
    console.log("EMBEDDING_PROVIDER=off — 回填已跳过（未生成任何向量）。");
    return;
  }

  const pool = getPool();
  // Constructed directly (not via embed-on-save.ts's narrowing
  // `resolveProvider`) because this script needs `resolveVersionIdentity`,
  // a capability specific to the concrete Ollama Provider that the narrow
  // `EmbeddingProvider` interface deliberately doesn't expose (F-1302's
  // "只换实现、不动调用方" narrow-interface rationale) — unlike
  // `embed-on-save.ts`'s fire-and-forget callers, an operator running this
  // script deliberately wants a loud, immediate failure if Ollama or the
  // configured model isn't actually available, so no try/catch here.
  const provider = new OllamaEmbeddingProvider(pool);
  const summary = await runBackfill(pool, provider);

  console.log(`当前配置目标 embedding_version：${summary.targetVersion}`);
  console.log(`Agent：处理 ${summary.agentsProcessed} 条。`);
  console.log(`任务：处理 ${summary.tasksProcessed} 条。`);
  console.log(
    `完成。仍缺失/过期：Agent ${summary.remainingStaleAgents}，任务 ${summary.remainingStaleTasks}` +
      (summary.remainingStaleAgents + summary.remainingStaleTasks > 0
        ? "（重新运行本脚本可继续处理剩余记录）"
        : ""),
  );
}

// Guards the CLI entrypoint so `backfill-embeddings.integration.test.ts`
// can import `runBackfill` directly (to test the real logic against a real
// pool/Provider) without this module's own `main()` also running as an
// import-time side effect — it would otherwise call `getPool()`/
// `closePool()` against whatever `DATABASE_URL` the test process happens
// to have, independent of and racing the test's own pool.
//
// `pathToFileURL(process.argv[1]).href === import.meta.url` (not a bare
// string `===` against a `fileURLToPath`-converted path) — this repo's own
// scripts/local-env/start.mjs documents a real incident with the naive
// form: `process.argv[1]` is not guaranteed to already be normalized to an
// absolute path for every invocation style, while `import.meta.url` always
// is; converting `argv[1]` up to a URL (rather than converting the URL
// down to a path) is the direction that stays correct regardless.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
