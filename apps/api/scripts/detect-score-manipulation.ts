// Feature 20 (agent-evaluation-appeal-antifraud), T-2005.
//
// F-2006's刷分检测 offline job — meant to be re-run periodically (cron or
// manual), not exposed as an HTTP endpoint: design.md's own interface-
// contract section only names `GET/POST /admin/risk-signals` (T-2008's
// governance queue), nothing that TRIGGERS detection itself, matching this
// codebase's existing `admin:bootstrap`/`backfill-embeddings` precedent for
// analysis/maintenance jobs an operator runs directly, not through a route.
//
// Run as `pnpm --filter @agent-market/api detect-score-manipulation`.
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import { detectScoreManipulation } from "../src/modules/antifraud/detection.js";
import {
  getRecentRatingCandidates,
  insertRiskSignal,
} from "../src/modules/antifraud/repository.js";

/** Comfortably wider than `detection.ts`'s own `suspiciousWindowHours`
 * default (24h) so a signal can't be missed by a late or delayed run — see
 * `getRecentRatingCandidates`'s own doc comment. */
const LOOKBACK_DAYS = 7;

export interface ScoreManipulationDetectionResult {
  inserted: number;
  skipped: number;
}

/** Exported (not just `main()`) so an integration test can call this
 * directly against a real seeded database without shelling out to the CLI
 * process — the same `export`+`main()`-guard split `admin-bootstrap.ts`
 * already establishes. */
export async function runScoreManipulationDetection(
  pool: Pool,
): Promise<ScoreManipulationDetectionResult> {
  const candidates = await getRecentRatingCandidates(pool, LOOKBACK_DAYS);
  const signals = detectScoreManipulation(candidates);

  // N4 real finding (P2): a separate "does an open signal already exist"
  // SELECT before this INSERT was a real TOCTOU race across overlapping
  // runs of this job — `insertRiskSignal` now relies on the database's own
  // partial unique index (`risk_signals_one_open_per_agent_and_type`) and
  // returns `null` when it's violated, which is genuinely race-safe (no
  // separate read step for two concurrent runs to both pass).
  let inserted = 0;
  let skipped = 0;
  for (const signal of signals) {
    const resultId = await insertRiskSignal(pool, {
      signalType: "SCORE_MANIPULATION",
      subjectAgentId: signal.agentId,
      subjectAddress: null,
      evidence: signal.evidence,
    });
    if (resultId) {
      inserted++;
    } else {
      skipped++;
    }
  }
  return { inserted, skipped };
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const result = await runScoreManipulationDetection(pool);
    console.log(
      `刷分检测完成：新建 ${result.inserted} 条风险信号，跳过 ${result.skipped} 条（该 Agent 已有未处理的同类信号）。`,
    );
  } finally {
    await closePool();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
