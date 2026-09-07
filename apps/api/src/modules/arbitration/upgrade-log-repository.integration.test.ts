import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import {
  insertArbitrationUpgradeLog,
  listArbitrationUpgradeLog,
} from "./upgrade-log-repository.js";

const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

const ADMIN_ADDRESS = "0xb283fefc63f0cd0e873a0000c6d07ef7b77e91db";
const OLD_ARBITRATOR_ADDRESS = "0xf283fefc63f0cd0e873a0000c6d07ef7b77e91df";
const SAFE_ADDRESS = "0xe283fefc63f0cd0e873a0000c6d07ef7b77e91de";
const TX_HASH_1 = "0x" + "a1".repeat(32);
const TX_HASH_2 = "0x" + "a2".repeat(32);

runIfOptedIn("arbitration/upgrade-log-repository (integration, T-2104)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM arbitration_upgrade_log");
  });

  it("records a real forward rotation (single EOA -> Safe) and returns its id", async () => {
    const id = await insertArbitrationUpgradeLog(pool, {
      actorAddress: ADMIN_ADDRESS,
      fromArbitratorAddress: OLD_ARBITRATOR_ADDRESS,
      toArbitratorAddress: SAFE_ADDRESS,
      txHash: TX_HASH_1,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const { rows } = await pool.query<{
      actor_address: string;
      from_arbitrator_address: string;
      to_arbitrator_address: string;
      tx_hash: string;
    }>(
      `SELECT actor_address, from_arbitrator_address, to_arbitrator_address, tx_hash FROM arbitration_upgrade_log WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      actor_address: ADMIN_ADDRESS,
      from_arbitrator_address: OLD_ARBITRATOR_ADDRESS,
      to_arbitrator_address: SAFE_ADDRESS,
      tx_hash: TX_HASH_1,
    });
  });

  it("listArbitrationUpgradeLog returns both a forward rotation and a later reverse rotation, most recent first", async () => {
    await insertArbitrationUpgradeLog(pool, {
      actorAddress: ADMIN_ADDRESS,
      fromArbitratorAddress: OLD_ARBITRATOR_ADDRESS,
      toArbitratorAddress: SAFE_ADDRESS,
      txHash: TX_HASH_1,
    });
    // A later reverse rotation (T-2109's own scenario) is just another
    // real row in the SAME table — no separate "rollback log" exists.
    await insertArbitrationUpgradeLog(pool, {
      actorAddress: ADMIN_ADDRESS,
      fromArbitratorAddress: SAFE_ADDRESS,
      toArbitratorAddress: OLD_ARBITRATOR_ADDRESS,
      txHash: TX_HASH_2,
    });

    const log = await listArbitrationUpgradeLog(pool);
    expect(log).toHaveLength(2);
    expect(log[0]?.txHash).toBe(TX_HASH_2);
    expect(log[1]?.txHash).toBe(TX_HASH_1);
  });

  it("rejects a malformed tx hash at the database boundary (the migration's own CHECK constraint, not application code)", async () => {
    await expect(
      insertArbitrationUpgradeLog(pool, {
        actorAddress: ADMIN_ADDRESS,
        fromArbitratorAddress: OLD_ARBITRATOR_ADDRESS,
        toArbitratorAddress: SAFE_ADDRESS,
        txHash: "not-a-real-hash",
      }),
    ).rejects.toThrow(/tx_hash_format/);
  });
});
