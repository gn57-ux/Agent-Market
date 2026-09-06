import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { detectAnomalousSessions, detectExposureConcentration } from "./fairness-monitor.js";

/**
 * F-1911/F-1912 (T-1908): real-Postgres proof that both monitoring queries
 * read `interaction_events` correctly and apply their own thresholds
 * honestly (no false "all clear" on genuinely lopsided/anomalous data, no
 * false alarm on genuinely normal data).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xb283fefc63f0cd0e873a0000c6d07ef7b77e91db";

runIfOptedIn("fairness-monitor (integration, T-1908)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM interaction_events");
    await pool.query("DELETE FROM agents");
  });

  async function insertAgent(): Promise<string> {
    const ownerAddress = `0x${Math.random().toString(16).slice(2).padEnd(40, "0")}`;
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      ownerAddress,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [ownerAddress],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertExposure(
    agentId: string,
    sessionId: string,
    occurredAt: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, agent_id, occurred_at)
       VALUES ('EXPOSURE', $1, $2, $3, $4)`,
      [sessionId, `exp-${agentId}-${Math.random()}`, agentId, occurredAt],
    );
  }

  async function insertViewOrClick(
    eventType: "VIEW" | "CLICK",
    sessionId: string,
    occurredAt: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO interaction_events (event_type, session_id, client_event_id, occurred_at)
       VALUES ($1, $2, $3, $4)`,
      [eventType, sessionId, `evt-${sessionId}-${Math.random()}`, occurredAt],
    );
  }

  describe("detectExposureConcentration", () => {
    it("does not flag a healthy, evenly-distributed exposure pattern", async () => {
      const agents = await Promise.all(Array.from({ length: 10 }, () => insertAgent()));
      for (const agentId of agents) {
        for (let i = 0; i < 5; i += 1) {
          await insertExposure(agentId, `session-${agentId}-${i}`, "2026-09-05T00:00:00.000Z");
        }
      }

      const result = await detectExposureConcentration(pool, {
        since: new Date("2026-09-01T00:00:00.000Z"),
      });

      expect(result.windowExposureCount).toBe(50);
      expect(result.distinctAgentCount).toBe(10);
      expect(result.flagged).toBe(false);
    });

    it("flags real head-monopoly: a handful of agents absorbing most real exposures", async () => {
      const dominantAgents = await Promise.all(Array.from({ length: 2 }, () => insertAgent()));
      const longTailAgents = await Promise.all(Array.from({ length: 8 }, () => insertAgent()));

      for (const agentId of dominantAgents) {
        for (let i = 0; i < 40; i += 1) {
          await insertExposure(agentId, `session-dom-${agentId}-${i}`, "2026-09-05T00:00:00.000Z");
        }
      }
      for (const agentId of longTailAgents) {
        await insertExposure(agentId, `session-tail-${agentId}`, "2026-09-05T00:00:00.000Z");
      }

      const result = await detectExposureConcentration(pool, {
        since: new Date("2026-09-01T00:00:00.000Z"),
        topAgentCount: 2,
      });

      expect(result.windowExposureCount).toBe(88);
      expect(result.flagged).toBe(true);
      expect(result.topAgentShares).toHaveLength(2);
      expect(result.topAgentShares[0]?.share).toBeGreaterThan(0.4);
    });

    it("only counts exposures inside the requested window", async () => {
      const agentId = await insertAgent();
      await insertExposure(agentId, "session-old", "2026-01-01T00:00:00.000Z");

      const result = await detectExposureConcentration(pool, {
        since: new Date("2026-09-01T00:00:00.000Z"),
      });

      expect(result.windowExposureCount).toBe(0);
      expect(result.flagged).toBe(false);
    });
  });

  describe("detectAnomalousSessions", () => {
    it("does not flag normal browsing volume", async () => {
      for (let i = 0; i < 5; i += 1) {
        await insertViewOrClick("VIEW", "session-normal", "2026-09-05T00:00:00.000Z");
      }

      const result = await detectAnomalousSessions(pool, {
        since: new Date("2026-09-01T00:00:00.000Z"),
      });

      expect(result.flaggedSessionIds).toEqual([]);
      expect(result.eventCountBySessionId.get("session-normal")).toBe(5);
    });

    it("flags a real click/view-farming session exceeding the rate threshold", async () => {
      for (let i = 0; i < 60; i += 1) {
        await insertViewOrClick(
          i % 2 === 0 ? "VIEW" : "CLICK",
          "session-farm",
          "2026-09-05T00:00:00.000Z",
        );
      }
      await insertViewOrClick("VIEW", "session-normal", "2026-09-05T00:00:00.000Z");

      const result = await detectAnomalousSessions(pool, {
        since: new Date("2026-09-01T00:00:00.000Z"),
        maxEventsPerSession: 50,
      });

      expect(result.flaggedSessionIds).toEqual(["session-farm"]);
      expect(result.eventCountBySessionId.get("session-farm")).toBe(60);
      expect(result.eventCountBySessionId.get("session-normal")).toBe(1);
    });

    it("N4 P2 fix: correctly counts a session id equal to a JS prototype property name", async () => {
      // `session_id` is client-supplied (T-1901's own collection endpoint,
      // fully adversary-controlled) — a plain object keyed by this value
      // would silently corrupt/lose the count instead of recording it.
      await insertViewOrClick("VIEW", "__proto__", "2026-09-05T00:00:00.000Z");
      await insertViewOrClick("CLICK", "__proto__", "2026-09-05T00:00:00.000Z");

      const result = await detectAnomalousSessions(pool, {
        since: new Date("2026-09-01T00:00:00.000Z"),
      });

      expect(result.eventCountBySessionId.get("__proto__")).toBe(2);
      expect(result.eventCountBySessionId instanceof Map).toBe(true);
    });
  });
});
