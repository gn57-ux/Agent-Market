// Feature 19 (ctr-online-learning), T-1907 (F-1910/F-1916, 用户 2026-09-06
// Q-1902 决策).
//
// Standalone CLI script (same convention as `train-ctr-model.ts`) — thin
// shell around `release-gate.ts`'s real logic.
//
// Run as:
//   pnpm --filter @agent-market/api manage-release-stage -- --check
//   pnpm --filter @agent-market/api manage-release-stage -- --advance --approved-by <address> --reason "<text>"
//   pnpm --filter @agent-market/api manage-release-stage -- --auto-rollback
import { pathToFileURL } from "node:url";
import { getPool, closePool } from "../src/db/pool.js";
import {
  advanceReleaseStage,
  checkAndAutoRollback,
  evaluateReleaseGate,
  getCurrentReleaseStage,
} from "../src/modules/ctr-training/release-gate.js";

function parseArgs(argv: string[]): {
  check: boolean;
  advance: boolean;
  autoRollback: boolean;
  approvedBy?: string;
  reason?: string;
} {
  let check = false;
  let advance = false;
  let autoRollback = false;
  let approvedBy: string | undefined;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--check") check = true;
    else if (argv[i] === "--advance") advance = true;
    else if (argv[i] === "--auto-rollback") autoRollback = true;
    else if (argv[i] === "--approved-by") approvedBy = argv[++i];
    else if (argv[i] === "--reason") reason = argv[++i];
  }
  return { check, advance, autoRollback, approvedBy, reason };
}

function formatSnapshot(
  stage: string,
  gate: Awaited<ReturnType<typeof evaluateReleaseGate>>,
): string {
  const lines = [
    `当前阶段：${stage}`,
    `评估时间：${gate.evaluatedAt}（窗口 ${gate.windowDays} 天）`,
    `就绪检查：${gate.readiness.ready ? "通过" : `未通过 — ${gate.readiness.blockedReason}`}`,
  ];
  if (gate.sampleGate) {
    lines.push(
      `样本量门槛：${gate.sampleGate.distinctTaskCount} 个不同 task｜${gate.sampleGate.sufficientSampleSize ? "达标" : "不达标"}`,
    );
  }
  if (gate.agreementGate) {
    lines.push(
      `排序一致率门槛：${gate.agreementGate.topOneAgreementRate ?? "无法计算"}｜${gate.agreementGate.meetsThreshold ? "达标" : "不达标"}`,
    );
  }
  if (gate.effectGate) {
    lines.push(
      `效果门槛：候选一致性 ${gate.effectGate.candidateConcordance} vs 生产基线 ${gate.effectGate.productionConcordance}（${gate.effectGate.pairCount} 对）｜${gate.effectGate.sufficientData ? (gate.effectGate.notRegressed ? "达标" : "未达标：相对退化") : "样本不足，无法判定"}`,
    );
  }
  if (gate.stabilityGate) {
    lines.push(
      `稳定性门槛：P95 ${gate.stabilityGate.p95LatencyMs ?? "无数据"}ms，错误/超时比例 ${gate.stabilityGate.errorOrTimeoutRate ?? "无数据"}｜${gate.stabilityGate.hasData ? (gate.stabilityGate.meetsLatencyThreshold && gate.stabilityGate.meetsErrorRateThreshold ? "达标" : "未达标") : "无数据"}`,
    );
  }
  lines.push(
    gate.eligibleForAdvancement
      ? "结论：满足全部门槛，可以推进（仍需人工执行 --advance 批准）"
      : `结论：不满足推进条件 — ${gate.blockedReasons.join("；")}`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const pool = getPool();
  const { check, advance, autoRollback, approvedBy, reason } = parseArgs(process.argv.slice(2));

  if (autoRollback) {
    const result = await checkAndAutoRollback(pool);
    if (!result) {
      const stage = await getCurrentReleaseStage(pool);
      console.log(`未触发回滚（当前阶段 ${stage}，门槛复检通过或本已处于 SHADOW）`);
      return;
    }
    console.log(
      `已自动回滚：${result.fromStage} → ${result.toStage}｜原因：${result.blockedReasons.join("；")}`,
    );
    return;
  }

  if (advance) {
    if (!approvedBy || !reason) {
      throw new Error(
        "manage-release-stage --advance 需要 --approved-by <address> 与 --reason <text>",
      );
    }
    const result = await advanceReleaseStage(pool, { approvedBy, reason });
    if (result.advanced) {
      console.log(`已推进：${result.fromStage} → ${result.toStage}（批准人 ${approvedBy}）`);
    } else {
      console.log(
        `未推进（${result.fromStage} → ${result.toStage ?? "无更高阶段"}）：${result.blockedReasons.join("；")}`,
      );
    }
    return;
  }

  if (check) {
    const stage = await getCurrentReleaseStage(pool);
    const gate = await evaluateReleaseGate(pool);
    console.log(formatSnapshot(stage, gate));
    return;
  }

  throw new Error(
    "manage-release-stage: --check，或 --advance --approved-by <address> --reason <text>，或 --auto-rollback",
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
