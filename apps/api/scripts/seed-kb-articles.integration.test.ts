import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { OllamaEmbeddingProvider } from "../src/modules/embeddings/ollama-provider.js";
import { computeEmbeddingVersion } from "../src/modules/embeddings/embed-on-save.js";
import { searchKbArticles } from "../src/modules/customer-service/kb-repository.js";
import { seedKbArticles, KB_ARTICLE_SEEDS } from "./seed-kb-articles.js";

/**
 * Feature 22 (ai-customer-service), T-2200 — real end-to-end verification
 * that the seed script + kb-repository.ts's search actually work together
 * against a real local Ollama and a real Postgres: runs the real seed
 * script (all real KB_ARTICLE_SEEDS entries, real embeddings), then embeds
 * a real query and confirms `searchKbArticles` returns the RIGHT article
 * by topic — not just "the query doesn't throw" (T-2200's own explicit
 * verification requirement).
 *
 * Skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1, same as
 * every other integration test in this repo — this ALSO requires a real
 * local Ollama at OLLAMA_BASE_URL (default http://127.0.0.1:11434) with
 * `bge-m3:latest` installed; no mocking.
 */
// N6 real finding: this file makes genuine calls to a real local Ollama
// daemon (no fake server, unlike routes.integration.test.ts/
// credential-redaction.integration.test.ts) — CI's own
// `db-integration-quality-gates` job sets RUN_DB_INTEGRATION_TESTS=1 but
// has no Ollama daemon at all, so gating on that flag alone made this
// file a genuine CI failure (real ECONNREFUSED against 127.0.0.1:11434 in
// GitHub Actions), first observed on PR #8. Requiring
// RUN_OLLAMA_INTEGRATION_TESTS too (the same flag
// intent-classifier.integration.test.ts already uses for its own
// real-Ollama-only suite) makes this correctly skip in CI while still
// running for a human with a real local Ollama — matching this repo's
// established "real-model tests are locally verified, not CI-gated"
// convention.
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("seed-kb-articles + kb-repository search (integration, T-2200)", () => {
  let pool: Pool;
  let provider: OllamaEmbeddingProvider;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    provider = new OllamaEmbeddingProvider(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  it("seeds every real KB entry and is idempotent (re-running updates, not duplicates)", async () => {
    const first = await seedKbArticles(pool, provider);
    expect(first.seeded).toBe(KB_ARTICLE_SEEDS.length);

    const { rows: afterFirst } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM kb_articles`,
    );
    expect(Number(afterFirst[0]?.count)).toBe(KB_ARTICLE_SEEDS.length);

    const second = await seedKbArticles(pool, provider);
    expect(second.seeded).toBe(KB_ARTICLE_SEEDS.length);

    const { rows: afterSecond } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM kb_articles`,
    );
    expect(Number(afterSecond[0]?.count)).toBe(KB_ARTICLE_SEEDS.length);
  }, 120_000);

  it("searchKbArticles returns the review-window article as the top match for a real query about it", async () => {
    await seedKbArticles(pool, provider);
    const embeddingVersion = computeEmbeddingVersion(await provider.resolveVersionIdentity());

    const query = await provider.embed("验收窗口是多久");
    const matches = await searchKbArticles(pool, query.vector, embeddingVersion, 3);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.title).toBe("验收窗口与正常验收流程");
    // A genuine top match should score meaningfully above an arbitrary
    // floor, not merely be first among ties/near-zero scores.
    expect(matches[0]?.similarity).toBeGreaterThan(0.3);
  }, 120_000);

  it("searchKbArticles returns the dispute/arbitration article as the top match for a real query about it", async () => {
    await seedKbArticles(pool, provider);
    const embeddingVersion = computeEmbeddingVersion(await provider.resolveVersionIdentity());

    const query = await provider.embed("发起争议之后仲裁是怎么裁决的");
    const matches = await searchKbArticles(pool, query.vector, embeddingVersion, 3);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.title).toBe("争议与仲裁流程");
  }, 120_000);

  it("excludes rows from a stale embedding_version (a real model/digest change) from ranking", async () => {
    await seedKbArticles(pool, provider);
    const currentVersion = computeEmbeddingVersion(await provider.resolveVersionIdentity());

    // Simulate a real post-model-update state: one row still carries an
    // old embedding_version but its vector now happens to be the closest
    // one in raw cosine terms to the query — it must still be excluded,
    // since comparing across incompatible vector spaces is meaningless.
    const target = await provider.embed("验收窗口是多久");
    await pool.query(
      `UPDATE kb_articles SET embedding = $1::vector, embedding_version = 'ollama:bge-m3:latest@stale-digest:dim1024:tmplv1'
       WHERE title = '验收窗口与正常验收流程'`,
      [`[${target.vector.join(",")}]`],
    );

    const matches = await searchKbArticles(pool, target.vector, currentVersion, 3);
    expect(matches.some((m) => m.title === "验收窗口与正常验收流程")).toBe(false);
  }, 120_000);

  it("a real mid-run failure leaves the knowledge base exactly as it was before the run (no partial content mix)", async () => {
    // Establish a known-good baseline first.
    await seedKbArticles(pool, provider);
    const { rows: before } = await pool.query<{ title: string; content: string }>(
      `SELECT title, content FROM kb_articles ORDER BY title`,
    );

    // A real failure on the LAST article of an edited seed set — real
    // embeds for every article before it (genuine partial progress, not
    // a zero-progress failure), then a genuine rejection.
    const editedSeeds = KB_ARTICLE_SEEDS.map((seed, index) =>
      index === 0 ? { ...seed, content: `${seed.content}（本次运行会失败前的编辑）` } : seed,
    );
    const originalEmbed = provider.embed.bind(provider);
    let callCount = 0;
    vi.spyOn(provider, "embed").mockImplementation(async (text: string) => {
      callCount += 1;
      if (callCount === KB_ARTICLE_SEEDS.length) {
        throw new Error("simulated real Ollama outage on the last article");
      }
      return originalEmbed(text);
    });

    await expect(seedKbArticles(pool, provider, editedSeeds)).rejects.toThrow(
      "simulated real Ollama outage",
    );
    vi.restoreAllMocks();

    const { rows: after } = await pool.query<{ title: string; content: string }>(
      `SELECT title, content FROM kb_articles ORDER BY title`,
    );
    expect(after).toEqual(before);
  }, 120_000);
});
