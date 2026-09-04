import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildAgentEmbeddingText, buildTaskEmbeddingText } from "./embed-on-save.js";
import { OllamaEmbeddingProvider } from "./ollama-provider.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

// Genuinely real local Ollama (no fake server) AND a real Postgres pool
// (OllamaEmbeddingProvider.embed() calls tryConsumeEmbeddingBudget) —
// gated behind BOTH opt-ins, same convention as
// ollama-provider.integration.test.ts's own real-Ollama suite.
//
// T-1307 v2: re-computes the exact 12-pair golden sample set documented in
// specs/13-vector-recall-scoring/golden-sample-calibration.md against
// REAL bge-m3 inference, and checks the results still support the
// calibrated `v02SemanticSimilarityThreshold = 0.64`
// (services/dispatch/internal/eligibility/eligibility.go). This is a
// drift detector, not a one-time calibration script: if a future
// `ollama pull bge-m3` changes the model's weights (a different digest),
// or the text template version changes, this suite re-verifies the
// threshold still classifies the golden set the same way it did when
// chosen — a genuine regression signal, not a synthetic one.
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

// Mirrors eligibility.go's v02SemanticSimilarityThreshold exactly — see
// that constant's own doc comment for the full calibration rationale.
// Necessarily duplicated across the Go/TS boundary (no shared-constant
// mechanism between the two languages); if that Go constant ever changes,
// this value must be updated to match, or this suite would silently stop
// verifying the real threshold.
const CALIBRATED_THRESHOLD = 0.64;

interface GoldenSample {
  label: string;
  category: string;
  task: { description: string; expertType: string; category: string; skillTags: string[] };
  agent: { description: string; category: string; skillTags: string[] };
  expected: "positive" | "negative";
  /** Documents a KNOWN, disclosed miss (see golden-sample-calibration.md)
   * — set only for the one sample whose real similarity falls on the
   * wrong side of the threshold despite an "positive" expectation. Keeps
   * this test honest about the real model's limits instead of silently
   * asserting something untrue. */
  knownMisclassification?: boolean;
}

const GOLDEN_SAMPLES: GoldenSample[] = [
  {
    label: "cross-category positive: UI design task vs. frontend Agent",
    category: "cross_category_positive",
    task: {
      description: "为我们的移动应用设计一套简洁美观的用户界面，注重可用性与视觉一致性",
      expertType: "DESIGN",
      category: "design",
      skillTags: ["UI设计", "移动端"],
    },
    agent: {
      description:
        "资深前端开发工程师，熟悉 React Native 与 Figma 设计交接流程，能独立完成界面还原",
      category: "programming",
      skillTags: ["React Native", "前端", "Figma"],
    },
    expected: "positive",
    knownMisclassification: true,
  },
  {
    label: "cross-category positive: ML deployment blog vs. MLOps Agent",
    category: "cross_category_positive",
    task: {
      description: "撰写一篇关于机器学习模型部署与线上监控的技术博客文章",
      expertType: "CONTENT_GENERATION",
      category: "writing",
      skillTags: ["技术写作", "机器学习"],
    },
    agent: {
      description: "MLOps 工程师，专注模型上线部署、性能监控与自动化运维",
      category: "engineering",
      skillTags: ["MLOps", "模型部署", "监控"],
    },
    expected: "positive",
  },
  {
    label: "cross-category positive: e-commerce translation vs. English copywriter",
    category: "cross_category_positive",
    task: {
      description: "为跨境电商网站翻译产品说明书，中文译为英文，语气需符合海外消费者习惯",
      expertType: "TRANSLATION",
      category: "translation",
      skillTags: ["中译英", "电商"],
    },
    agent: {
      description: "英语母语文案编辑，擅长电商营销文案与产品描述本地化",
      category: "writing",
      skillTags: ["英语文案", "本地化", "电商"],
    },
    expected: "positive",
  },
  {
    label: "hard negative: Python scraper vs. matplotlib chart maker",
    category: "hard_negative",
    task: {
      description: "开发一个 Python 爬虫程序，定期抓取电商网站商品价格数据",
      expertType: "AUTOMATION",
      category: "programming",
      skillTags: ["Python", "爬虫", "数据抓取"],
    },
    agent: {
      description: "Python 数据可视化图表制作，仅使用 matplotlib 绘制静态统计图表，不涉及数据采集",
      category: "design",
      skillTags: ["Python", "matplotlib", "图表"],
    },
    expected: "negative",
  },
  {
    label: "hard negative: Logo design vs. Java backend architect",
    category: "hard_negative",
    task: {
      description: "为公司设计一个全新的品牌 Logo，需要体现科技感与专业性",
      expertType: "DESIGN",
      category: "design",
      skillTags: ["Logo设计", "品牌"],
    },
    agent: {
      description: "资深 Java 后端工程师，为电商系统设计高并发分布式架构",
      category: "programming",
      skillTags: ["Java", "架构设计", "高并发"],
    },
    expected: "negative",
  },
  {
    label: "hard negative: medical device PRD vs. consumer electronics PM",
    category: "hard_negative",
    task: {
      description: "撰写一份新药临床试验的产品需求文档",
      expertType: "CONTENT_GENERATION",
      category: "product",
      skillTags: ["医疗", "PRD", "临床试验"],
    },
    agent: {
      description: "消费电子产品经理，负责智能音箱类产品的路线图规划",
      category: "product",
      skillTags: ["消费电子", "产品规划", "路线图"],
    },
    expected: "negative",
  },
  {
    label: "same-category positive: unit tests vs. QA engineer",
    category: "same_category_positive",
    task: {
      description: "编写单元测试用例，提高核心模块的代码覆盖率",
      expertType: "AUTOMATION",
      category: "programming",
      skillTags: ["单元测试", "自动化测试"],
    },
    agent: {
      description: "专注自动化测试与质量保障的高级测试工程师，擅长编写高覆盖率单元测试",
      category: "programming",
      skillTags: ["自动化测试", "QA", "单元测试"],
    },
    expected: "positive",
  },
  {
    label: "same-category positive: press release vs. PR copywriter",
    category: "same_category_positive",
    task: {
      description: "为新产品发布会撰写一份新闻稿",
      expertType: "CONTENT_GENERATION",
      category: "writing",
      skillTags: ["新闻稿", "公关"],
    },
    agent: {
      description: "资深公关文案撰稿人，擅长撰写新闻稿与媒体通稿",
      category: "writing",
      skillTags: ["公关文案", "新闻稿"],
    },
    expected: "positive",
  },
  {
    label: "cross-lingual (same category): SEO strategy (en) vs. SEO expert (zh)",
    category: "cross_lingual",
    task: {
      description:
        "Write a comprehensive SEO strategy for an e-commerce website to improve organic search ranking",
      expertType: "CONTENT_GENERATION",
      category: "marketing",
      skillTags: ["SEO", "e-commerce"],
    },
    agent: {
      description: "资深 SEO 优化专家，擅长电商网站搜索引擎优化策略与关键词布局",
      category: "marketing",
      skillTags: ["SEO", "电商", "关键词优化"],
    },
    expected: "positive",
  },
  {
    label: "cross-lingual (cross category): mobile onboarding (en) vs. frontend Agent (zh)",
    category: "cross_lingual",
    task: {
      description:
        "Design a smooth onboarding flow and micro-interactions for a mobile app's first-time users",
      expertType: "DESIGN",
      category: "design",
      skillTags: ["onboarding", "mobile UX"],
    },
    agent: {
      description: "前端开发工程师，擅长实现移动端引导页面与交互动画效果",
      category: "programming",
      skillTags: ["前端开发", "交互动画", "移动端"],
    },
    expected: "positive",
  },
  {
    label: "irrelevant: financial audit vs. pet photographer",
    category: "irrelevant",
    task: {
      description: "为初创公司做年度财务审计，核对账目并出具审计报告",
      expertType: "AUTOMATION",
      category: "finance",
      skillTags: ["财务审计", "会计"],
    },
    agent: {
      description: "宠物摄影师，专注猫狗肖像拍摄与宠物写真后期修图",
      category: "photography",
      skillTags: ["宠物摄影", "后期修图"],
    },
    expected: "negative",
  },
  {
    label: "irrelevant: yoga workshop vs. smart contract auditor",
    category: "irrelevant",
    task: {
      description: "组织一场线下瑜伽工作坊，招募学员并安排场地",
      expertType: "AUTOMATION",
      category: "events",
      skillTags: ["瑜伽", "线下活动"],
    },
    agent: {
      description: "区块链智能合约审计师，专注 Solidity 合约安全漏洞检测",
      category: "programming",
      skillTags: ["区块链", "智能合约", "安全审计"],
    },
    expected: "negative",
  },
];

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    normA += (a[i] as number) * (a[i] as number);
    normB += (b[i] as number) * (b[i] as number);
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

runIfOptedIn("golden sample calibration (real bge-m3, T-1307 v2)", () => {
  let pool: Pool;
  let provider: OllamaEmbeddingProvider;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    provider = new OllamaEmbeddingProvider(pool);
    // Codex review (T-1307 v2 P2): this suite makes ~48 real embed() calls
    // (2 per golden sample × 12 samples, run twice — once in the `it.each`
    // loop, once in the separation-check test), each incrementing this
    // month's `embedding_budget_usage.call_count`. Clearing before AND
    // after (not just relying on whatever count happens to already be
    // there) means a repeated run in the same calendar month never
    // silently approaches `DEFAULT_MONTHLY_BUDGET`, and this suite never
    // leaves behind usage that could affect an unrelated test's own
    // budget-related assertions later in the same test database/month.
    await pool.query("DELETE FROM embedding_budget_usage");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM embedding_budget_usage");
    await pool.end();
  });

  it.each(GOLDEN_SAMPLES)(
    "$label",
    async ({ task, agent, expected, knownMisclassification }) => {
      const taskResult = await provider.embed(buildTaskEmbeddingText(task));
      const agentResult = await provider.embed(buildAgentEmbeddingText(agent));
      const similarity = cosineSimilarity(taskResult.vector, agentResult.vector);

      const actual = similarity >= CALIBRATED_THRESHOLD ? "positive" : "negative";

      if (knownMisclassification) {
        // Pins the ONE known, disclosed exception documented in
        // golden-sample-calibration.md — if this ever starts passing
        // (the real model's similarity for this pair crosses the
        // threshold), that's a real, informative change worth noticing,
        // not something to silently let slide either way.
        expect(actual).not.toBe(expected);
      } else {
        expect(actual).toBe(expected);
      }
    },
    30_000,
  );

  it("every negative sample scores no higher than every non-exceptional positive sample's lower bound (the real separation the threshold sits inside)", async () => {
    const similarities = await Promise.all(
      GOLDEN_SAMPLES.map(async (sample) => {
        const taskResult = await provider.embed(buildTaskEmbeddingText(sample.task));
        const agentResult = await provider.embed(buildAgentEmbeddingText(sample.agent));
        return {
          category: sample.category,
          expected: sample.expected,
          knownMisclassification: sample.knownMisclassification ?? false,
          similarity: cosineSimilarity(taskResult.vector, agentResult.vector),
        };
      }),
    );

    const negatives = similarities.filter((s) => s.expected === "negative");
    const reliablePositives = similarities.filter(
      (s) => s.expected === "positive" && !s.knownMisclassification,
    );

    const maxNegative = Math.max(...negatives.map((s) => s.similarity));
    const minReliablePositive = Math.min(...reliablePositives.map((s) => s.similarity));

    expect(maxNegative).toBeLessThan(minReliablePositive);
    expect(maxNegative).toBeLessThan(CALIBRATED_THRESHOLD);
    expect(minReliablePositive).toBeGreaterThan(CALIBRATED_THRESHOLD);
  }, 60_000);
});
