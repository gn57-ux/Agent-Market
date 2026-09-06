// Feature 20 (agent-evaluation-appeal-antifraud), T-2006.
//
// F-2008's串谋检测 offline job — same "operator-run analysis job, not an
// HTTP endpoint" reasoning as `detect-score-manipulation.ts`'s own doc
// comment.
//
// Run as `pnpm --filter @agent-market/api detect-collusion`.
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import { detectCollusion } from "../src/modules/antifraud/detection.js";
import { getRatedTaskPairs, insertRiskSignal } from "../src/modules/antifraud/repository.js";

export interface CollusionDetectionResult {
  inserted: number;
  skipped: number;
}

export async function runCollusionDetection(pool: Pool): Promise<CollusionDetectionResult> {
  const candidates = await getRatedTaskPairs(pool);
  const signals = detectCollusion(candidates);

  let inserted = 0;
  let skipped = 0;
  for (const signal of signals) {
    const resultId = await insertRiskSignal(pool, {
      signalType: "COLLUSION",
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
    const result = await runCollusionDetection(pool);
    console.log(
      `串谋检测完成：新建 ${result.inserted} 条风险信号，跳过 ${result.skipped} 条（该 Agent 已有未处理的同类信号）。`,
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
