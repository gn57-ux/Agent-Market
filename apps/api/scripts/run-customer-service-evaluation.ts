// Feature 22 (ai-customer-service), T-2207 (F-2209/AC-2201).
//
// AC-2201's own words: "真实提交一批评估集问题，意图分类准确率、'是否有知识库
// 引用支撑'两项指标有真实测量记录（不是构造的理想化数据）". This script is
// that real measurement: it runs the real `classifyIntent`/`generateAnswer`
// pipeline (real local Ollama, real Postgres `kb_articles`) against every
// item in `../src/modules/customer-service/evaluation-set.ts` and prints a
// real, human-readable per-item + aggregate report — nothing here is
// mocked or pre-computed.
//
// Run as `pnpm --filter @agent-market/api run-customer-service-evaluation`
// (requires a reachable local Ollama with `qwen3:8b`/`bge-m3:latest`, and
// `DATABASE_URL` pointing at a real Postgres the caller is willing to seed
// the real T-2200 knowledge base into).
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import { OllamaEmbeddingProvider } from "../src/modules/embeddings/ollama-provider.js";
import {
  CUSTOMER_SERVICE_EVALUATION_SET,
  type EvaluationItem,
} from "../src/modules/customer-service/evaluation-set.js";
import {
  classifyIntent,
  type IntentCategory,
} from "../src/modules/customer-service/intent-classifier.js";
import { generateAnswer } from "../src/modules/customer-service/answer-generator.js";
import { seedKbArticles } from "./seed-kb-articles.js";

export interface EvaluationItemResult {
  question: string;
  expectedIntent: IntentCategory;
  expectedGrounded: boolean;
  /** `null` when `classifyIntent` itself threw (e.g. Ollama unreachable) —
   * a real failure, not a classification result, so it's never coerced
   * into a fake "wrong" category. */
  actualIntent: IntentCategory | null;
  classificationCorrect: boolean;
  /** `escalate === false && citedKbArticleIds.length > 0` from a real
   * `generateAnswer(pool, question, null)` call. */
  actualGrounded: boolean;
  citedKbArticleIds: string[];
  answer: string;
}

export interface EvaluationReport {
  items: EvaluationItemResult[];
  /** Real measured % of ALL items whose `classifyIntent` result matched
   * `expectedIntent`. */
  classificationAccuracy: number;
  /** Real measured % of the `expectedGrounded: true` items whose real
   * `generateAnswer` call actually came back grounded (non-empty real
   * citations, not escalated) — AC-2201's "是否有知识库引用支撑" metric. */
  citationSupportRate: number;
  groundedExpectedCount: number;
  /** N4 real finding (round 1, T-2207, P2): real measured % of the
   * `expectedGrounded: false` items (out-of-scope/KB-gap/personal-status
   * negative samples) that correctly did NOT come back grounded — the
   * mirror-image anti-hallucination metric `citationSupportRate` alone
   * cannot express, since it never looks at these items at all. */
  noHallucinationRate: number;
  ungroundedExpectedCount: number;
}

/**
 * Core evaluation logic. Real, standalone, and imported directly by
 * `run-customer-service-evaluation.integration.test.ts` (not shelled out
 * to) so the test exercises the exact same code path this CLI script runs.
 * Every item makes TWO real calls: `classifyIntent` (independent signal for
 * the classification-accuracy metric — NOT read off `generateAnswer`'s own
 * `.intent` field, because that field is hardcoded to `"UNHANDLED"` on a
 * genuine classifier failure/error, which would misrepresent a real
 * infrastructure fault as a classification miss) and `generateAnswer` (the
 * real end-to-end grounding signal for the citation-support metric).
 */
export async function runCustomerServiceEvaluation(
  pool: Pool,
  evaluationSet: readonly EvaluationItem[] = CUSTOMER_SERVICE_EVALUATION_SET,
): Promise<EvaluationReport> {
  const items: EvaluationItemResult[] = [];

  for (const item of evaluationSet) {
    let actualIntent: IntentCategory | null;
    try {
      const classification = await classifyIntent(item.question);
      actualIntent = classification.intent;
    } catch {
      actualIntent = null;
    }

    const answerResult = await generateAnswer(pool, item.question, null);
    const actualGrounded = !answerResult.escalate && answerResult.citedKbArticleIds.length > 0;

    items.push({
      question: item.question,
      expectedIntent: item.expectedIntent,
      expectedGrounded: item.expectedGrounded,
      actualIntent,
      classificationCorrect: actualIntent === item.expectedIntent,
      actualGrounded,
      citedKbArticleIds: answerResult.citedKbArticleIds,
      answer: answerResult.answer,
    });
  }

  const classificationCorrectCount = items.filter((item) => item.classificationCorrect).length;
  const classificationAccuracy =
    items.length === 0 ? 0 : (classificationCorrectCount / items.length) * 100;

  const groundedExpectedItems = items.filter((item) => item.expectedGrounded);
  const groundedAndActuallyGroundedCount = groundedExpectedItems.filter(
    (item) => item.actualGrounded,
  ).length;
  const citationSupportRate =
    groundedExpectedItems.length === 0
      ? 0
      : (groundedAndActuallyGroundedCount / groundedExpectedItems.length) * 100;

  // N4 real finding (round 1, T-2207, P2): the citation-support rate above
  // only ever measures the `expectedGrounded: true` items — every
  // out-of-scope/KB-gap/personal-status negative sample (`expectedGrounded:
  // false`) was previously excluded from EVERY real metric, so a real
  // hallucination regression on one of THOSE items (the model fabricating
  // a confident, cited answer for a question the KB genuinely can't
  // support) would never move either number and could pass silently
  // forever. `noHallucinationRate` closes that gap: among the negative
  // samples, what real fraction correctly did NOT come back grounded
  // (`actualGrounded === false`) — this is the real, measured mirror of
  // AC-2202's own anti-hallucination guarantee, aggregated the same way
  // `citationSupportRate` aggregates the positive samples.
  const ungroundedExpectedItems = items.filter((item) => !item.expectedGrounded);
  const correctlyUngroundedCount = ungroundedExpectedItems.filter(
    (item) => !item.actualGrounded,
  ).length;
  const noHallucinationRate =
    ungroundedExpectedItems.length === 0
      ? 0
      : (correctlyUngroundedCount / ungroundedExpectedItems.length) * 100;

  return {
    items,
    classificationAccuracy,
    citationSupportRate,
    groundedExpectedCount: groundedExpectedItems.length,
    noHallucinationRate,
    ungroundedExpectedCount: ungroundedExpectedItems.length,
  };
}

/** Human-readable report — printed by both this script's `main()` and (via
 * `console.log`) `run-customer-service-evaluation.integration.test.ts`, so
 * the real measured numbers are visible in both a manual run and test
 * output. */
export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push("=== Feature 22 客服评估集（T-2207/AC-2201）真实测量报告 ===");
  lines.push("");
  for (const [index, item] of report.items.entries()) {
    const classificationMark = item.classificationCorrect ? "PASS" : "FAIL";
    const groundingMark = item.expectedGrounded
      ? item.actualGrounded
        ? "PASS"
        : "FAIL"
      : "N/A（不计入引用支撑率）";
    lines.push(`[${index + 1}] ${item.question}`);
    lines.push(
      `    意图分类：期望=${item.expectedIntent} 实际=${item.actualIntent ?? "(分类失败)"} [${classificationMark}]`,
    );
    lines.push(
      `    知识库引用：期望${item.expectedGrounded ? "有" : "无"}支撑 实际${item.actualGrounded ? "有" : "无"}支撑（引用条目：${item.citedKbArticleIds.join(", ") || "无"}）[${groundingMark}]`,
    );
    lines.push(`    真实回答：${item.answer}`);
    lines.push("");
  }
  lines.push("=== 真实测量的聚合指标 ===");
  lines.push(
    `意图分类准确率：${report.classificationAccuracy.toFixed(1)}%（${report.items.filter((i) => i.classificationCorrect).length}/${report.items.length}）`,
  );
  lines.push(
    `知识库引用支撑率（仅计入 ${report.groundedExpectedCount} 条期望有支撑的问题）：${report.citationSupportRate.toFixed(1)}%`,
  );
  lines.push(
    `防幻觉率（仅计入 ${report.ungroundedExpectedCount} 条期望无支撑的越界/知识库缺口问题，衡量模型是否正确拒绝编造引用）：${report.noHallucinationRate.toFixed(1)}%`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    // Ensure the real T-2200 knowledge base is actually present/current in
    // whatever database this script is pointed at — same idempotent upsert
    // `answer-generator.integration.test.ts`'s own `beforeAll` relies on,
    // so a fresh checkout can run this script without a separate manual
    // seeding step first.
    const provider = new OllamaEmbeddingProvider(pool);
    await seedKbArticles(pool, provider);

    const report = await runCustomerServiceEvaluation(pool);
    console.log(formatEvaluationReport(report));
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
