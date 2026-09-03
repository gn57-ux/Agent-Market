import type { Queryable } from "../../db/pool.js";

/**
 * F-1303's monthly call-count ceiling — read at call time (not memoized),
 * matching this codebase's established pattern for env-derived config
 * (tasks/service.ts's `resolveRequiredConfirmations`) so tests can flip it
 * between calls without a process restart. No exact number was part of the
 * user's confirmed decisions (§8.1 only confirmed "an independent monthly
 * ceiling exists," not its value) — this default is a deliberately
 * conservative placeholder for the two-day MVP scope.
 *
 * T-1308 (Ollama migration): reframed from a $-cost ceiling into a
 * Provider-agnostic local-resource ceiling (F-1303/F-1310) — `bge-m3` runs
 * on this machine's own CPU/GPU, so unbounded calls threaten local
 * latency/compute headroom, not a billing account. The mechanism (an
 * atomic per-month counter in Postgres) and its "one caller-visible
 * function, `tryConsumeEmbeddingBudget`" shape are unchanged; only the
 * resource being protected changed, which is why this stays a single
 * wrapper layer rather than something duplicated per Provider (F-1303's
 * explicit "禁止在不同 Provider 中复制计数规则").
 */
const DEFAULT_MONTHLY_BUDGET = 2000;

export function resolveMonthlyEmbeddingBudget(): number {
  const raw = process.env.EMBEDDING_MONTHLY_BUDGET;
  if (!raw) {
    return DEFAULT_MONTHLY_BUDGET;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return DEFAULT_MONTHLY_BUDGET;
  }
  return parsed;
}

/** UTC calendar month, `YYYY-MM` — matches `embedding_budget_usage.year_month`
 * (0016_create_embedding_budget.sql). UTC (not local time) so this doesn't
 * depend on the server process's timezone configuration. */
function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Atomically attempts to consume one unit of this month's embedding call
 * budget. Returns `true` if the caller may proceed with a real Provider
 * call, `false` if the monthly ceiling (`resolveMonthlyEmbeddingBudget`) has
 * already been reached — callers (ollama-provider.ts) must treat `false`
 * exactly like any other Provider failure mode (F-1304's degrade path),
 * never as a special case requiring different handling.
 *
 * F-1303 also requires "单次任务/Agent 保存事件最多触发一次（不重试）" — that
 * per-save-event cap is the CALLER's own discipline (embed-on-save.ts,
 * T-1302: call `embed` at most once per save, never retry on failure), not
 * something this function enforces; this function's only job is the
 * monthly ceiling.
 *
 * Race-safe under real concurrency: `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE` is a single atomic statement — Postgres evaluates the `WHERE`
 * clause against the row's currently-committed value as part of the same
 * statement, so two concurrent calls can never both observe "under budget"
 * and both increment past the ceiling (unlike a separate
 * SELECT-then-UPDATE, which would have exactly that race).
 */
export async function tryConsumeEmbeddingBudget(pool: Queryable): Promise<boolean> {
  const limit = resolveMonthlyEmbeddingBudget();
  if (limit <= 0) {
    return false;
  }
  const { rows } = await pool.query<{ call_count: number }>(
    `INSERT INTO embedding_budget_usage (year_month, call_count)
     VALUES ($1, 1)
     ON CONFLICT (year_month) DO UPDATE
       SET call_count = embedding_budget_usage.call_count + 1
       WHERE embedding_budget_usage.call_count < $2
     RETURNING call_count`,
    [currentYearMonth(), limit],
  );
  return rows.length > 0;
}
