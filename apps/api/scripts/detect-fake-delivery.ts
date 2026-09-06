// Feature 20 (agent-evaluation-appeal-antifraud), T-2006.
//
// F-2007's虚假交付检测 offline job — same "operator-run analysis job, not
// an HTTP endpoint" reasoning as `detect-score-manipulation.ts`'s own doc
// comment.
//
// Run as `pnpm --filter @agent-market/api detect-fake-delivery`.
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import { detectFakeDelivery } from "../src/modules/antifraud/detection.js";
import { getDeliveryHashRecords, insertRiskSignal } from "../src/modules/antifraud/repository.js";

export interface FakeDeliveryDetectionResult {
  inserted: number;
  skipped: number;
}

export async function runFakeDeliveryDetection(pool: Pool): Promise<FakeDeliveryDetectionResult> {
  const records = await getDeliveryHashRecords(pool);
  const signals = detectFakeDelivery(records);

  let inserted = 0;
  let skipped = 0;
  for (const signal of signals) {
    const resultId = await insertRiskSignal(pool, {
      signalType: "FAKE_DELIVERY",
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
    const result = await runFakeDeliveryDetection(pool);
    console.log(
      `虚假交付检测完成：新建 ${result.inserted} 条风险信号，跳过 ${result.skipped} 条（该 Agent 已有未处理的同类信号）。`,
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
