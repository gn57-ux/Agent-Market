import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runScoreManipulationDetection } from "./detect-score-manipulation.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. F-2006/T-2005's real end-to-end proof (AC-2003 前半):
// a genuine刷分 pattern (real ratings, real requester accounts, real
// timestamps) produces exactly one `risk_signals` row and modifies NO other
// business state (design.md 决策 1's whole point) — this is the one place
// that claim is checked against a real database, not just the pure
// `detection.ts` unit tests' fixture arrays.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, " +
  "sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

const AGENT_OWNER_ADDRESS = "0x" + "b1".repeat(20);
const TOKEN_ADDRESS = "0x" + "b2".repeat(20);

runIfOptedIn(
  "detect-score-manipulation runScoreManipulationDetection (integration, T-2005)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        AGENT_OWNER_ADDRESS,
      ]);
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
    });

    afterEach(async () => {
      await pool.query("DELETE FROM risk_signals");
      await pool.query("DELETE FROM ratings");
      await pool.query("DELETE FROM tasks");
      await pool.query("DELETE FROM agents");
      await pool.query(`DELETE FROM users WHERE address <> $1`, [AGENT_OWNER_ADDRESS]);
    });

    async function insertAgent(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
        [AGENT_OWNER_ADDRESS],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertAgent: no id returned");
      return id;
    }

    let requesterCounter = 0;
    async function insertNewRequester(createdAt: Date): Promise<string> {
      requesterCounter++;
      const address = `0xc${requesterCounter.toString().padStart(39, "0")}`;
      await pool.query(`INSERT INTO users (address, created_at) VALUES ($1, $2)`, [
        address,
        createdAt,
      ]);
      return address;
    }

    async function insertRatedTask(
      agentId: string,
      requesterAddress: string,
      score: number,
      ratedAt: Date,
    ): Promise<void> {
      const {
        rows: [task],
      } = await pool.query<{ id: string }>(
        `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'RELEASED', $3, 'AUTOMATION')
       RETURNING id`,
        [requesterAddress, TOKEN_ADDRESS, agentId],
      );
      const taskId = task?.id;
      if (!taskId) throw new Error("insertRatedTask: no task id returned");
      await pool.query(
        `INSERT INTO ratings (task_id, requester_address, score, created_at) VALUES ($1, $2, $3, $4)`,
        [taskId, requesterAddress, score, ratedAt],
      );
    }

    it("detects a real 刷分 pattern, creates exactly one risk_signals row, and modifies no other business state (AC-2003 前半)", async () => {
      const agentId = await insertAgent();
      const now = new Date();
      const hourMs = 60 * 60 * 1000;

      for (let i = 0; i < 3; i++) {
        const requester = await insertNewRequester(new Date(now.getTime() - 3 * hourMs));
        await insertRatedTask(agentId, requester, 5, new Date(now.getTime() - (2 - i) * hourMs));
      }

      const before = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
        agentId,
      ]);

      const result = await runScoreManipulationDetection(pool);

      expect(result.inserted).toBe(1);
      expect(result.skipped).toBe(0);

      const { rows: signalRows } = await pool.query<{
        signal_type: string;
        subject_agent_id: string;
        status: string;
        evidence: { ratingIds: string[]; requesterAddresses: string[] };
      }>(`SELECT signal_type, subject_agent_id, status, evidence FROM risk_signals`);
      expect(signalRows).toHaveLength(1);
      expect(signalRows[0]?.signal_type).toBe("SCORE_MANIPULATION");
      expect(signalRows[0]?.subject_agent_id).toBe(agentId);
      expect(signalRows[0]?.status).toBe("DETECTED");
      expect(signalRows[0]?.evidence.ratingIds).toHaveLength(3);
      expect(signalRows[0]?.evidence.requesterAddresses).toHaveLength(3);

      // design.md 决策 1: detection must never touch any other business state.
      const after = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
        agentId,
      ]);
      expect(after.rows).toEqual(before.rows);
    });

    it("does not flag a normal rating pattern (few ratings, or from established accounts)", async () => {
      const agentId = await insertAgent();
      const now = new Date();
      const establishedRequester = await insertNewRequester(
        new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
      );
      await insertRatedTask(agentId, establishedRequester, 5, now);

      const result = await runScoreManipulationDetection(pool);

      expect(result.inserted).toBe(0);
      const { rows } = await pool.query(`SELECT * FROM risk_signals`);
      expect(rows).toHaveLength(0);
    });

    it("is idempotent: re-running while a signal is still DETECTED does not create a duplicate", async () => {
      const agentId = await insertAgent();
      const now = new Date();
      const hourMs = 60 * 60 * 1000;
      for (let i = 0; i < 3; i++) {
        const requester = await insertNewRequester(new Date(now.getTime() - 3 * hourMs));
        await insertRatedTask(agentId, requester, 5, new Date(now.getTime() - (2 - i) * hourMs));
      }

      const first = await runScoreManipulationDetection(pool);
      expect(first.inserted).toBe(1);

      const second = await runScoreManipulationDetection(pool);
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(1);

      const { rows } = await pool.query(`SELECT * FROM risk_signals`);
      expect(rows).toHaveLength(1);
    });

    it("raises a NEW signal once the previous one has been resolved (not stuck open forever)", async () => {
      const agentId = await insertAgent();
      const now = new Date();
      const hourMs = 60 * 60 * 1000;
      for (let i = 0; i < 3; i++) {
        const requester = await insertNewRequester(new Date(now.getTime() - 3 * hourMs));
        await insertRatedTask(agentId, requester, 5, new Date(now.getTime() - (2 - i) * hourMs));
      }

      await runScoreManipulationDetection(pool);
      await pool.query(`UPDATE risk_signals SET status = 'DISMISSED' WHERE subject_agent_id = $1`, [
        agentId,
      ]);

      const second = await runScoreManipulationDetection(pool);
      expect(second.inserted).toBe(1);

      const { rows } = await pool.query(
        `SELECT status FROM risk_signals WHERE subject_agent_id = $1`,
        [agentId],
      );
      expect(rows).toHaveLength(2);
    });

    it("N4 P2 fix: two truly concurrent detection runs never both insert a signal for the same Agent (real race, not simulated)", async () => {
      const agentId = await insertAgent();
      const now = new Date();
      const hourMs = 60 * 60 * 1000;
      for (let i = 0; i < 3; i++) {
        const requester = await insertNewRequester(new Date(now.getTime() - 3 * hourMs));
        await insertRatedTask(agentId, requester, 5, new Date(now.getTime() - (2 - i) * hourMs));
      }

      // Fired with Promise.all (no await between them) — both runs reach
      // insertRiskSignal before either has committed, the same real race
      // the database's own unique index (not this test's own timing) must
      // resolve.
      const [first, second] = await Promise.all([
        runScoreManipulationDetection(pool),
        runScoreManipulationDetection(pool),
      ]);

      const insertedCounts = [first.inserted, second.inserted].sort();
      expect(insertedCounts).toEqual([0, 1]);

      const { rows } = await pool.query(`SELECT id FROM risk_signals WHERE subject_agent_id = $1`, [
        agentId,
      ]);
      expect(rows).toHaveLength(1);
    });
  },
);
