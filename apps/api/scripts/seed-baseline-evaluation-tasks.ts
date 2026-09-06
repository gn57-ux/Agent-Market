// Feature 20 (agent-evaluation-appeal-antifraud), T-2009.
//
// F-2012's real question bank — 用户 2026-09-06 Q-2001 决策："采用运营人工
// 题库方案。首批 10-20 道，覆盖 2-3 个主要 category，及格线确定为 60/100"。
// This script IS that first batch: 15 real `RULE_BASED` evaluation tasks
// across 3 categories (writing/engineering/design), each with a genuine
// prompt and a real `KEYWORD_PRESENCE` rubric (2 required keywords per
// question — matching `BASELINE_EVALUATION_PASSING_SCORE = 60`, since
// `rule-scorer.ts`'s own formula makes 1/2 keywords = 50 < 60 and 2/2 = 100
// >= 60, so a genuinely half-right answer does not pass). This is real
// starter content an operator can expand or replace — not placeholder
// junk — but it is still exactly the FIRST batch the user's own decision
// calls for, not a claim that 15 questions is the platform's permanent
// question bank size.
//
// Idempotent: `rubric_version` is this script's own stable identifier per
// question (`baseline-v1-<category>-<n>`) — re-running skips any question
// whose `rubric_version` already exists (`ON CONFLICT DO NOTHING`) rather
// than duplicating the question bank on a second run.
//
// Run as `pnpm --filter @agent-market/api seed-baseline-evaluation-tasks`.
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";

interface BaselineQuestion {
  rubricVersion: string;
  category: string;
  title: string;
  prompt: string;
  requiredKeywords: string[];
}

const BASELINE_QUESTIONS: BaselineQuestion[] = [
  // --- writing (文案/写作) ---
  {
    rubricVersion: "baseline-v1-writing-01",
    category: "writing",
    title: "产品发布公告",
    prompt: "为一款新上线的效率工具撰写一段产品发布公告（100-200字）。",
    requiredKeywords: ["发布日期", "核心功能"],
  },
  {
    rubricVersion: "baseline-v1-writing-02",
    category: "writing",
    title: "解释标题党",
    prompt: "用通俗的语言解释什么是「标题党」这种写作现象，并说明它的问题所在。",
    requiredKeywords: ["夸张", "点击"],
  },
  {
    rubricVersion: "baseline-v1-writing-03",
    category: "writing",
    title: "客服致歉文案",
    prompt: "为一次因系统故障导致用户数据延迟同步的事件，撰写一段客服致歉文案。",
    requiredKeywords: ["抱歉", "解决方案"],
  },
  {
    rubricVersion: "baseline-v1-writing-04",
    category: "writing",
    title: "长文摘要技巧",
    prompt: "总结将一篇长文章压缩成摘要的三个实用技巧。",
    requiredKeywords: ["关键词", "结构"],
  },
  {
    rubricVersion: "baseline-v1-writing-05",
    category: "writing",
    title: "AIDA 营销模型",
    prompt: "解释 AIDA 营销模型的基本含义，并说明它如何应用在文案写作中。",
    requiredKeywords: ["注意力", "行动"],
  },
  // --- engineering (工程/代码) ---
  {
    rubricVersion: "baseline-v1-engineering-01",
    category: "engineering",
    title: "解释幂等性",
    prompt: "解释接口设计中「幂等性」的含义，并举一个实际场景说明为什么它重要。",
    requiredKeywords: ["重复", "相同结果"],
  },
  {
    rubricVersion: "baseline-v1-engineering-02",
    category: "engineering",
    title: "数据库事务 ACID",
    prompt: "解释数据库事务 ACID 特性中原子性和一致性分别指什么。",
    requiredKeywords: ["原子性", "一致性"],
  },
  {
    rubricVersion: "baseline-v1-engineering-03",
    category: "engineering",
    title: "RESTful API 核心原则",
    prompt: "解释 RESTful API 设计的核心原则，重点说明资源和 HTTP 方法的关系。",
    requiredKeywords: ["资源", "HTTP方法"],
  },
  {
    rubricVersion: "baseline-v1-engineering-04",
    category: "engineering",
    title: "解释竞态条件",
    prompt: "解释什么是竞态条件（race condition），并说明它为什么和并发执行顺序有关。",
    requiredKeywords: ["并发", "顺序"],
  },
  {
    rubricVersion: "baseline-v1-engineering-05",
    category: "engineering",
    title: "单元测试与集成测试的区别",
    prompt: "解释单元测试和集成测试的核心区别。",
    requiredKeywords: ["隔离", "真实"],
  },
  // --- design (设计) ---
  {
    rubricVersion: "baseline-v1-design-01",
    category: "design",
    title: "响应式设计",
    prompt: "解释什么是响应式设计，说明它如何应对不同的屏幕尺寸。",
    requiredKeywords: ["屏幕尺寸", "自适应"],
  },
  {
    rubricVersion: "baseline-v1-design-02",
    category: "design",
    title: "可用性与可访问性",
    prompt: "解释可用性（usability）和可访问性（accessibility）的区别。",
    requiredKeywords: ["易用", "无障碍"],
  },
  {
    rubricVersion: "baseline-v1-design-03",
    category: "design",
    title: "设计系统的作用",
    prompt: "解释为什么一个产品团队需要建立设计系统，它解决了什么问题。",
    requiredKeywords: ["一致性", "组件"],
  },
  {
    rubricVersion: "baseline-v1-design-04",
    category: "design",
    title: "用户旅程图",
    prompt: "解释什么是用户旅程图（user journey map），它记录了哪些内容。",
    requiredKeywords: ["触点", "体验"],
  },
  {
    rubricVersion: "baseline-v1-design-05",
    category: "design",
    title: "留白在界面设计中的作用",
    prompt: "解释留白（负空间）在界面设计中起到什么作用。",
    requiredKeywords: ["视觉", "呼吸感"],
  },
];

export interface SeedResult {
  inserted: number;
  skipped: number;
}

/**
 * N4 real finding (P2): the original version inserted the rubric and its
 * task as two SEPARATE, non-transactional statements — a failure (or the
 * process dying) between them left a real rubric row with NO task
 * referencing it. On re-run, `ON CONFLICT (rubric_version) DO NOTHING`
 * found the rubric already existed and returned no row, so that question
 * was silently `skipped` FOREVER — the script would keep reporting success
 * while permanently missing that one question's task. Fixed two ways: (1)
 * each question's rubric+task pair is now one atomic transaction, so a
 * mid-question failure can never leave an orphan rubric; (2) on a rubric-
 * already-exists conflict, the script now looks up the existing rubric and
 * self-heals by inserting the missing task if one doesn't already exist,
 * rather than assuming "rubric exists" already implies "task exists too."
 */
export async function seedBaselineEvaluationTasks(pool: Pool): Promise<SeedResult> {
  let inserted = 0;
  let skipped = 0;
  for (const q of BASELINE_QUESTIONS) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: insertedRubricRows } = await client.query<{ id: string }>(
        `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
         VALUES ($1, $2, $3)
         ON CONFLICT (rubric_version) DO NOTHING
         RETURNING id`,
        [
          q.rubricVersion,
          q.category,
          JSON.stringify({ type: "KEYWORD_PRESENCE", requiredKeywords: q.requiredKeywords }),
        ],
      );

      let rubricId = insertedRubricRows[0]?.id;
      if (!rubricId) {
        const { rows: existingRubricRows } = await client.query<{ id: string }>(
          `SELECT id FROM evaluation_rubrics WHERE rubric_version = $1`,
          [q.rubricVersion],
        );
        rubricId = existingRubricRows[0]?.id;
        if (!rubricId) {
          throw new Error(
            `seedBaselineEvaluationTasks: rubric_version ${q.rubricVersion} conflicted but could not be re-read`,
          );
        }
        const { rows: existingTaskRows } = await client.query<{ id: string }>(
          `SELECT id FROM evaluation_tasks WHERE rubric_id = $1`,
          [rubricId],
        );
        if (existingTaskRows.length > 0) {
          await client.query("COMMIT");
          skipped++;
          continue;
        }
        // Self-heal: the rubric exists but its task was never created
        // (exactly the orphan this fix prevents going forward).
      }

      await client.query(
        `INSERT INTO evaluation_tasks (rubric_id, title, prompt, scoring_mode)
         VALUES ($1, $2, $3, 'RULE_BASED')`,
        [rubricId, q.title, q.prompt],
      );
      await client.query("COMMIT");
      inserted++;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return { inserted, skipped };
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const result = await seedBaselineEvaluationTasks(pool);
    console.log(
      `基础评测题库录入完成：新增 ${result.inserted} 道，跳过 ${result.skipped} 道（rubric_version 已存在）。`,
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
