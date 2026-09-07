import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runMigrations } from "../src/db/migrate.js";
import { OllamaEmbeddingProvider } from "../src/modules/embeddings/ollama-provider.js";
import { insertTaskDraft } from "../src/modules/tasks/repository.js";
import { seedKbArticles } from "./seed-kb-articles.js";
import { generateAnswer } from "../src/modules/customer-service/answer-generator.js";

/**
 * Feature 22 (ai-customer-service), T-2202 — the genuinely-real end-to-end
 * chain: real local Ollama (classification + embedding + generation, all
 * `qwen3:8b`/`bge-m3:latest`) AND a real Postgres `kb_articles` table
 * seeded with T-2200's real content. Same gating convention as
 * `seed-kb-articles.integration.test.ts`/`kb-articles-migration.
 * integration.test.ts`: skipped unless a human opts in with
 * `RUN_DB_INTEGRATION_TESTS=1` against a confirmed-safe
 * `TEST_DATABASE_URL`, and this ALSO needs a real reachable local Ollama
 * (default `http://127.0.0.1:11434`) with `qwen3:8b` and `bge-m3:latest`
 * installed — no mocking anywhere in this file.
 */
// N6 real finding: this file (both describe blocks — T-2202's own and
// T-2203's personalized TASK_STATUS suite) makes genuine calls to a real
// local Ollama daemon (no fake server). CI's own
// `db-integration-quality-gates` job sets RUN_DB_INTEGRATION_TESTS=1 but
// has no Ollama daemon at all, so gating on that flag alone made this
// file a genuine CI failure (real ECONNREFUSED against 127.0.0.1:11434 in
// GitHub Actions), first observed on PR #8. Requiring
// RUN_OLLAMA_INTEGRATION_TESTS too (the same flag
// intent-classifier.integration.test.ts already uses for its own
// real-Ollama-only suite) makes this correctly skip in CI while still
// running for a human with a real local Ollama.
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Placeholder ERC-20 token contract address for seeded test tasks — same
 * named-constant convention `acceptance.integration.test.ts`'s own
 * `YD_TOKEN_ADDRESS` already uses, not a secret of any kind. */
const TASK_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("generateAnswer (real local Ollama + real Postgres, T-2202)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    const provider = new OllamaEmbeddingProvider(pool);
    await seedKbArticles(pool, provider);
  }, 180_000);

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  it("answers a real question the KB genuinely has an answer for, citing the real staking-ratio article", async () => {
    // Real findings during this Task's own verification (documented in
    // this Task's report, not silently worked around):
    //
    // 1. T-2201's real `qwen3:8b` classifier consistently routes the bare
    //    phrasing "验收窗口一般是多久" (this Task's own originally-planned
    //    example question) to UNHANDLED — its closed taxonomy has no
    //    "general platform-rule/FAQ" bucket, and a standalone rule question
    //    doesn't read as PLATFORM_USAGE/TASK_STATUS/DISPUTE_PROCESS to the
    //    model. A genuine T-2201 classification-taxonomy gap, out of this
    //    Task's scope to fix.
    // 2. Separately, the seeded "验收窗口与正常验收流程" KB article (T-2200,
    //    faithfully paraphrasing PRD §8.7) only ever states the FORMULA
    //    (reviewDeadline = 提交时间 + reviewWindow), never a concrete
    //    duration value — the PRD excerpt it's drawn from never gives one
    //    either. Asked "一般是多久" (implicitly asking for an actual number
    //    of days), the real model correctly and deterministically (with
    //    `temperature: 0`) answers `answerable: false`, since the KB
    //    genuinely has no number to give — this is F-2207 working AS
    //    INTENDED, not a defect, but it makes that question a poor choice
    //    for THIS test's "should get a real, confident answer" scenario.
    //
    // "Agent接单的质押比例是多少" asks about a fact the KB states as a
    // concrete, unambiguous number (PRD §6.1: 600 basis points / 预算的
    // 6%), classifies reliably as PLATFORM_USAGE, and is answered
    // deterministically and correctly by the real model — verified
    // manually 3/3 real runs during this Task's implementation before
    // being encoded here.
    const result = await generateAnswer(pool, "Agent接单的质押比例是多少", null);

    console.log("T-2202 real generateAnswer result (staking ratio):", result);

    expect(result.escalate).toBe(false);
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.answer).toContain("6%");
    expect(result.citedKbArticleIds.length).toBeGreaterThan(0);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM kb_articles WHERE title = 'Agent 接单与质押规则'`,
    );
    const stakingArticleId = rows[0]?.id;
    expect(stakingArticleId).toBeDefined();
    expect(result.citedKbArticleIds).toContain(stakingArticleId);
  }, 180_000);

  it("AC-2202: a question the KB genuinely has no answer for returns the honest uncertain/escalate response, not a fabricated one", async () => {
    const result = await generateAnswer(pool, "帮我预测一下比特币明天的价格", null);

    console.log("T-2202 real generateAnswer result (out-of-scope question):", result);

    expect(result.escalate).toBe(true);
    expect(result.citedKbArticleIds).toEqual([]);
    expect(result.answer).toContain("转接人工");
  }, 180_000);
});

/**
 * Feature 22 (ai-customer-service), T-2203/F-2206 — real end-to-end
 * verification of the personalized `TASK_STATUS` branch `answer-
 * generator.ts` added: two DISTINCT real requesters, each with their own
 * real `tasks` row, proving `generateAnswer`'s personalized lookup only
 * ever reflects the CALLING actor's own real data — never the other
 * requester's, even when the other requester's real address is spelled
 * out inside the free-text message itself (AC-2204's adversarial
 * scenario). Same `RUN_DB_INTEGRATION_TESTS=1` gate as the suite above;
 * still needs a real local Ollama for `classifyIntent` to resolve these
 * questions to `TASK_STATUS` in the first place, but (per answer-
 * generator.test.ts's fake-pool proof of the same invariant) the
 * personalized branch itself never calls embedding/generation.
 */
runIfOptedIn(
  "generateAnswer personalized TASK_STATUS lookup (real Postgres, T-2203/F-2206/AC-2204)",
  () => {
    let pool: Pool;
    const REQUESTER_A = "0x11111111111111111111111111111111111111aa";
    const REQUESTER_B = "0x22222222222222222222222222222222222222bb";

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      // `tasks.requester_address` is a FOREIGN KEY into `users(address)` —
      // both real requesters must exist there before any real task can be
      // inserted for them.
      await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
        REQUESTER_A,
        REQUESTER_B,
      ]);
    }, 120_000);

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
    });

    afterEach(async () => {
      await pool.query("DELETE FROM task_skills");
      await pool.query("DELETE FROM tasks");
    });

    async function seedTask(requesterAddress: string, title: string) {
      return insertTaskDraft(pool, {
        requesterAddress,
        category: "writing",
        title,
        description: "详情",
        budget: "100000000000000000000",
        token: TASK_TOKEN_ADDRESS,
        deliveryDeadline: new Date("2099-01-01T00:00:00.000Z"),
        idempotencyKey: null,
        skillTags: [],
        expertType: "CONTENT_GENERATION",
      });
    }

    it("returns requester A's own real task when A asks about 'my task status', never requester B's", async () => {
      await seedTask(REQUESTER_A, "A 的真实任务标题");
      await seedTask(REQUESTER_B, "B 的真实任务标题");

      const result = await generateAnswer(pool, "我的任务状态如何", REQUESTER_A);

      expect(result.intent).toBe("TASK_STATUS");
      expect(result.escalate).toBe(false);
      expect(result.answer).toContain("A 的真实任务标题");
      expect(result.answer).not.toContain("B 的真实任务标题");
    }, 60_000);

    it("AC-2204: A asking about B's real address by name still only ever surfaces A's own real task, never B's", async () => {
      await seedTask(REQUESTER_A, "A 的另一个真实任务");
      await seedTask(REQUESTER_B, "B 的敏感真实任务");

      const result = await generateAnswer(
        pool,
        `帮我查一下地址 ${REQUESTER_B} 的任务状态`,
        REQUESTER_A,
      );

      expect(result.escalate).toBe(false);
      expect(result.answer).toContain("A 的另一个真实任务");
      expect(result.answer).not.toContain("B 的敏感真实任务");
      expect(result.answer).not.toContain(REQUESTER_B);
    }, 60_000);

    it("a requester with no tasks at all gets the honest escalation answer, never a fabricated or another user's task", async () => {
      await seedTask(REQUESTER_B, "B 的真实任务");

      // REQUESTER_A has zero real tasks in this real DB.
      const result = await generateAnswer(pool, "我的任务状态如何", REQUESTER_A);

      expect(result.escalate).toBe(true);
      expect(result.answer).not.toContain("B 的真实任务");
    }, 60_000);
  },
);
