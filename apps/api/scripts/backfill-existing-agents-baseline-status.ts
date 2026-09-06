// Feature 20 (agent-evaluation-appeal-antifraud), T-2009.
//
// 用户 2026-09-06 Q-2001 决策的"存量 Agent 迁移策略"部分——F-2012 的字面
// 名称是"新 Agent 撮合准入门槛"，requirements.md 的动机也是新 Agent，不是
// 要求所有存量 Agent 补考一个它们创建时根本不存在的评测流程。设计比较
// （CLAUDE.md 原则 3）：(A，选用) 一次性把当前所有 `NOT_STARTED` 的 Agent
// 直接标记为 `PASSED`（既往不咎，只对本次运行之后创建的 Agent 生效）——
// 与 F-2012"新 Agent"的字面范围一致，且是这个平台已有的保守迁移先例
// （Feature 16 T-1607 的 admin-bootstrap.ts 同样是"一次性手动运行的迁移脚
// 本，不是自动触发的后台任务"）；(B，弃用) 要求所有存量 Agent 也必须真实
// 通过评测才能继续被撮合——这会让平台上线当天就把所有真实在用的 Agent 瞬
// 间排除在撮合之外，是一次真实的服务中断，且没有任何用户指令要求如此激
// 进的处理。
//
// 必须在 `BASELINE_EVALUATION_GATE_ENABLED=1` 之前运行一次（手动，一次
// 性）——运行顺序：
//   1. pnpm --filter @agent-market/api seed-baseline-evaluation-tasks
//   2. pnpm --filter @agent-market/api backfill-existing-agents-baseline-status
//   3. 确认以上两步都成功后，再把 BASELINE_EVALUATION_GATE_ENABLED 设为 1
//
// 只影响仍是 `NOT_STARTED` 的 Agent——任何已经真实提交过评测（`PENDING`/
// `PASSED`/`FAILED`）的 Agent 保留其真实状态，不被这个一次性迁移覆盖。
//
// Run as `pnpm --filter @agent-market/api backfill-existing-agents-baseline-status`.
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";

export interface BackfillResult {
  updated: number;
}

export async function backfillExistingAgentsBaselineStatus(pool: Pool): Promise<BackfillResult> {
  const { rowCount } = await pool.query(
    `UPDATE agents SET baseline_evaluation_status = 'PASSED' WHERE baseline_evaluation_status = 'NOT_STARTED'`,
  );
  return { updated: rowCount ?? 0 };
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const result = await backfillExistingAgentsBaselineStatus(pool);
    console.log(
      `存量 Agent 迁移完成：${result.updated} 个 Agent 从 NOT_STARTED 迁移为 PASSED（既往不咎，只对本次运行之后创建的 Agent 生效基础评测门槛）。`,
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
