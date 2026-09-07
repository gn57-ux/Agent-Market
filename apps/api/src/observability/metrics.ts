import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import type { Pool } from "pg";

/**
 * T-2305 (Feature 23, F-2307/AC-2305): the single owner of every Prometheus
 * metric this system exposes (CLAUDE.md 原则 6) — business call sites
 * (`tasks/service.ts`, `dispatch.client.ts`, `settlement-stats.ts`) import
 * only the specific counter/histogram they increment/observe, never define
 * their own metric or touch the registry directly.
 *
 * AC-2305's five required categories, each mapped to exactly one metric
 * family below: 任务发布量 → `tasksPublishedTotal`; 匹配延迟 →
 * `dispatchMatchDuration`; 结算成功率 → `settlementOutcomeTotal` (a ratio
 * derived from the `outcome` label at query time, not stored as a
 * pre-computed ratio — Prometheus's own convention: never bake a rate into
 * a gauge when the raw counters are cheap to expose); 队列积压 →
 * `outboxQueueBacklog`; 索引进度 → `indexerScanCheckpoint`.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const metricsContentType = registry.contentType;

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method/route/status_code",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

export const tasksPublishedTotal = new Counter({
  name: "tasks_published_total",
  help: "Tasks that transitioned AWAITING_FUNDING -> OPEN (a task is genuinely live for matching)",
  registers: [registry],
});

export const dispatchMatchDuration = new Histogram({
  name: "dispatch_match_duration_seconds",
  help: "Duration of apps/api's call to the Go dispatch service's POST /match, labeled by outcome",
  labelNames: ["outcome"],
  registers: [registry],
});

export const settlementOutcomeTotal = new Counter({
  name: "settlement_outcome_total",
  help: "Terminal task settlements, labeled by outcome (success/non_success) — settlement_success_rate = success / (success + non_success)",
  labelNames: ["outcome"],
  registers: [registry],
});

/**
 * Gauges backed by a live DB query at SCRAPE time (not updated on every
 * write) — `outbox_events`/`indexer_scan_checkpoints` are already each
 * table's own single source of truth for this state (design.md: "不需要
 * 额外的指标专用表"), so re-deriving from them on each scrape avoids a
 * second, potentially-drifting copy of the same fact.
 */
const outboxQueueBacklog = new Gauge({
  name: "outbox_queue_backlog",
  help: "Number of outbox_events rows still PENDING (not yet published to the queue)",
  registers: [registry],
});

const indexerScanCheckpoint = new Gauge({
  name: "indexer_scan_checkpoint_block",
  help: "Each chain's last_scanned_block from indexer_scan_checkpoints, labeled by chain_id",
  labelNames: ["chain_id"],
  registers: [registry],
});

/**
 * `GET /internal/metrics`'s route handler calls this instead of
 * `registry.metrics()` directly — refreshes the two live-DB-backed gauges
 * from `pool` immediately before rendering, so every scrape reflects
 * current state rather than whatever the last scrape happened to observe.
 * A query failure here must not crash the whole metrics response (every
 * OTHER metric should still render even if one live-DB gauge's query
 * fails) — caught inside `refreshOutboxBacklog`/`refreshIndexerCheckpoints`
 * themselves, leaving that one gauge at its last successfully observed
 * value rather than propagating.
 */
export async function renderMetrics(pool: Pool): Promise<string> {
  await Promise.all([refreshOutboxBacklog(pool), refreshIndexerCheckpoints(pool)]);
  return registry.metrics();
}

async function refreshOutboxBacklog(pool: Pool): Promise<void> {
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM outbox_events WHERE status = 'PENDING'`,
    );
    outboxQueueBacklog.set(Number(rows[0]?.count ?? 0));
  } catch {
    // Leave the gauge at its last value — a query failure here (e.g. pool
    // exhausted) must not take down the entire /internal/metrics response.
  }
}

async function refreshIndexerCheckpoints(pool: Pool): Promise<void> {
  try {
    const { rows } = await pool.query<{ chain_id: string; last_scanned_block: string }>(
      `SELECT chain_id, last_scanned_block FROM indexer_scan_checkpoints`,
    );
    // N4 real finding (round 1, T-2305, P2): only ever SETTING a label
    // never removes one — a chain_id whose checkpoint row was deleted (or
    // simply absent from a later query) kept exposing its last-known value
    // forever, no longer reflecting the database's current state. `reset()`
    // clears every previously observed label combination for this gauge
    // right before repopulating it from the query that just succeeded — a
    // query FAILURE (the catch below) intentionally does NOT reach this
    // reset, so a transient DB error still leaves the gauge at its last
    // good values rather than blanking it.
    indexerScanCheckpoint.reset();
    for (const row of rows) {
      indexerScanCheckpoint.set({ chain_id: row.chain_id }, Number(row.last_scanned_block));
    }
  } catch {
    // Same reasoning as refreshOutboxBacklog.
  }
}
