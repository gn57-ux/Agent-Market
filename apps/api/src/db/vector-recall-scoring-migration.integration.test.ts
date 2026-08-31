import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1300's own verification that
// 0015_create_vector_recall_scoring.sql actually enforces, at the database
// layer, the properties specs/13-vector-recall-scoring/design.md's data
// model requires: ratings.communication_score's optional 1-5 range,
// recommendation_candidates' new nullable columns, and (dimension-agnostic)
// that an out-of-range vector/dimension value is rejected.
//
// T-1309 (Ollama migration) note: this file originally also asserted a real
// round-trip store, CASCADE delete, and cosine-distance (`<=>`) query at
// 1536 dimensions — those assertions describe 0015's schema in ISOLATION,
// which no longer matches any fully-migrated real database once
// 0017_ollama_embedding_dimension.sql (always applied after 0015, in every
// real deployment) has also run and rebuilt both tables at 1024
// dimensions. Per this project's "不篡改已执行的" rule, 0015's own .sql file
// is untouched — only these now-inaccurate test assertions were removed,
// with equivalent coverage (round-trip, CASCADE delete, cosine query,
// task-embedding storage) reinstated at the real, current dimension in
// ollama-embedding-dimension-migration.integration.test.ts instead.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const OWNER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e90d9";
const REQUESTER_ADDRESS = "0xb283fefc63f0cd0e873a0000c6d07ef7b77e90da";
const TOKEN_ADDRESS = "0xc283fefc63f0cd0e873a0000c6d07ef7b77e90db";

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

runIfOptedIn(
  "agent_embeddings / task_embeddings / ratings.communication_score / recommendation_candidates migration (integration)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
        OWNER_ADDRESS,
        REQUESTER_ADDRESS,
      ]);
    });

    afterAll(async () => {
      await pool.query(
        "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
      );
      await pool.end();
    });

    async function insertAgent(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Test Agent', 'desc', 'writing', $1) RETURNING id`,
        [OWNER_ADDRESS],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertAgent: no id returned");
      return id;
    }

    async function insertTask(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
         VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2033-01-01T00:00:00Z', 'DRAFT', 'AUTOMATION')
         RETURNING id`,
        [REQUESTER_ADDRESS, TOKEN_ADDRESS],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertTask: no id returned");
      return id;
    }

    // T-1309 note: this file's original round-trip / CASCADE-delete /
    // cosine-query / task-embedding-storage tests, and its
    // dimension-value-mismatch test (which relied on a real 1536-long
    // vector to isolate that specific check), lived here — removed because
    // 0017_ollama_embedding_dimension.sql (always applied after 0015 in any
    // real deployment) makes their literal 1536-dim assertions false.
    // Equivalent coverage, at the real current dimension, now lives in
    // ollama-embedding-dimension-migration.integration.test.ts. This
    // dimension-agnostic check (any array too short for either candidate
    // width) is the one property from that original set general enough to
    // keep here.
    it("rejects a vector with the wrong dimension", async () => {
      const agentId = await insertAgent();
      await expect(
        pool.query(
          `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
           VALUES ($1, $2, 'openai', 'text-embedding-3-small', 1536, 'v1')`,
          [agentId, toVectorLiteral([1, 2, 3])],
        ),
      ).rejects.toThrow();
    });

    it("accepts a well-formed communication_score alongside the existing score, and leaves it NULL when omitted", async () => {
      const taskWithScore = await insertTask();
      const { rows: withScore } = await pool.query<{ communication_score: number | null }>(
        `INSERT INTO ratings (task_id, requester_address, score, communication_score)
         VALUES ($1, $2, 5, 4) RETURNING communication_score`,
        [taskWithScore, REQUESTER_ADDRESS],
      );
      expect(withScore[0]?.communication_score).toBe(4);

      const taskWithoutScore = await insertTask();
      const { rows: withoutScore } = await pool.query<{ communication_score: number | null }>(
        `INSERT INTO ratings (task_id, requester_address, score)
         VALUES ($1, $2, 3) RETURNING communication_score`,
        [taskWithoutScore, REQUESTER_ADDRESS],
      );
      expect(withoutScore[0]?.communication_score).toBeNull();
    });

    it("rejects a communication_score outside 1-5", async () => {
      const taskId = await insertTask();
      await expect(
        pool.query(
          `INSERT INTO ratings (task_id, requester_address, score, communication_score)
           VALUES ($1, $2, 5, 6)`,
          [taskId, REQUESTER_ADDRESS],
        ),
      ).rejects.toThrow();
    });

    it("recommendation_candidates accepts optional semantic_similarity/reputation_signals, NULL by default", async () => {
      const taskId = await insertTask();
      const agentId = await insertAgent();
      const { rows: runRows } = await pool.query<{ id: string }>(
        `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
         VALUES ($1, 'v0.1', 1, 'test-digest') RETURNING id`,
        [taskId],
      );
      const runId = runRows[0]?.id;

      const { rows: bareRows } = await pool.query<{
        semantic_similarity: number | null;
        reputation_signals: unknown;
      }>(
        `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
         VALUES ($1, $2, 1, 'TOP_SCORE', 0.5, '{}')
         RETURNING semantic_similarity, reputation_signals`,
        [runId, agentId],
      );
      expect(bareRows[0]?.semantic_similarity).toBeNull();
      expect(bareRows[0]?.reputation_signals).toBeNull();

      const agentId2 = await insertAgent();
      const signals = {
        completionRate: 0.9,
        qualityFeedback: 0.8,
        communication: null,
        disputeSignal: 1,
        historicalScale: 0.25,
      };
      const { rows: v2Rows } = await pool.query<{
        semantic_similarity: number | null;
        reputation_signals: typeof signals;
      }>(
        `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons, semantic_similarity, reputation_signals)
         VALUES ($1, $2, 2, 'TOP_SCORE', 0.8, '{}', 0.87, $3)
         RETURNING semantic_similarity, reputation_signals`,
        [runId, agentId2, JSON.stringify(signals)],
      );
      expect(v2Rows[0]?.semantic_similarity).toBe(0.87);
      expect(v2Rows[0]?.reputation_signals).toEqual(signals);
    });

    // Codex review (T-1309 P2): 0017_ollama_embedding_dimension.sql (always
    // applied after 0015 in this test file's own `beforeAll`, matching any
    // real deployment) depends on the tables 0015 creates. Rolling back
    // 0015 alone — without first rolling back 0017 — drops those tables
    // while leaving 0017's row in `schema_migrations` untouched, so a
    // later `runMigrations` call skips 0017 (already "applied") and only
    // reapplies 0015, leaving the database at 1536 dimensions while
    // bookkeeping still claims 0017 (which rebuilds it to 1024) ran. Both
    // rollbacks now run in proper dependency order (0017 before 0015), and
    // the final re-apply assertion proves the WHOLE chain — not just
    // 0015 alone — replays back to a genuinely consistent, current state.
    it("rollback (0017 then 0015, in dependency order) drops both embeddings tables and the new columns, and the full migration chain can be reapplied", async () => {
      const readRollback = (file: string) =>
        import("node:fs").then((fs) =>
          fs.readFileSync(
            path.join(
              path.dirname(fileURLToPath(import.meta.url)),
              `../../migrations/rollback/${file}`,
            ),
            "utf8",
          ),
        );

      await pool.query(await readRollback("0017_ollama_embedding_dimension.rollback.sql"));
      await pool.query(await readRollback("0015_create_vector_recall_scoring.rollback.sql"));

      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('agent_embeddings', 'task_embeddings')`,
      );
      expect(tables).toHaveLength(0);

      const { rows: columns } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE (table_name = 'ratings' AND column_name = 'communication_score')
            OR (table_name = 'recommendation_candidates' AND column_name IN ('semantic_similarity', 'reputation_signals'))`,
      );
      expect(columns).toHaveLength(0);

      const { rows: migrationRows } = await pool.query<{ id: string }>(
        `SELECT id FROM schema_migrations
         WHERE id IN ('0015_create_vector_recall_scoring.sql', '0017_ollama_embedding_dimension.sql')`,
      );
      expect(migrationRows).toHaveLength(0);

      const result = await runMigrations(pool, migrationsDir);
      expect(result.applied).toEqual([
        "0015_create_vector_recall_scoring.sql",
        "0017_ollama_embedding_dimension.sql",
      ]);

      // Proves the reapplied chain is genuinely consistent (not merely
      // "both rows present in schema_migrations") — the real, current
      // 1024-dim shape 0017 produces, not a stale 1536-dim table that
      // bookkeeping incorrectly claims was superseded.
      const { rows: udt } = await pool.query<{ udt_name: string }>(
        `SELECT udt_name FROM information_schema.columns
         WHERE table_name = 'agent_embeddings' AND column_name = 'embedding'`,
      );
      expect(udt[0]?.udt_name).toBe("vector");
      await expect(
        pool.query(
          `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
           SELECT id, $1, 'openai', 'text-embedding-3-small', 1536, 'v1' FROM agents LIMIT 1`,
          [`[${Array.from({ length: 1536 }, (_, i) => i).join(",")}]`],
        ),
      ).rejects.toThrow();
    });
  },
);
