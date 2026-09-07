import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 21 (arbitration-committee), T-2102 —
 * 0040_create_arbitration_committee_tables.sql's own real-Postgres
 * verification.
 *
 * Covers: all three tables exist with their real FK/CHECK constraints;
 * `arbitration_committee_members`' ACTIVE/REMOVED field-pairing invariant
 * and the "at most one ACTIVE row per address" partial unique index;
 * `arbitration_upgrade_log`'s address/tx-hash format constraints (shared
 * by both a forward rotation and T-2109's later reverse rotation —
 * deliberately the same table, not a separate "rollback log");
 * `arbitration_decisions`' real FK to `disputes` and the "at least two
 * signers" CHECK (F-2107's own literal consequence: a real 2/3 Safe
 * execution can never have fewer than 2 real signatures); rollback drops
 * all three tables; the migration can be reapplied (up → down → up).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";
const ADMIN_ADDRESS = "0xb283fefc63f0cd0e873a0000c6d07ef7b77e91db";
const MEMBER_A = "0xc283fefc63f0cd0e873a0000c6d07ef7b77e91dc";
const MEMBER_B = "0xd283fefc63f0cd0e873a0000c6d07ef7b77e91dd";
const SAFE_ADDRESS = "0xe283fefc63f0cd0e873a0000c6d07ef7b77e91de";
const OLD_ARBITRATOR_ADDRESS = "0xf283fefc63f0cd0e873a0000c6d07ef7b77e91df";
const TX_HASH = "0x" + "a1".repeat(32);
const SAFE_TX_HASH = "0x" + "b2".repeat(32);
const ONCHAIN_TX_HASH = "0x" + "c3".repeat(32);

runIfOptedIn("0040_create_arbitration_committee_tables migration (integration, T-2102)", () => {
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
    await pool.query("DELETE FROM arbitration_decisions");
    await pool.query("DELETE FROM arbitration_upgrade_log");
    await pool.query("DELETE FROM arbitration_committee_members");
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM tasks");
  });

  async function insertDispute(): Promise<string> {
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 100, $2, now() + interval '7 days', 'DISPUTED', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const taskId = task?.id ?? "";
    const {
      rows: [dispute],
    } = await pool.query<{ id: string }>(
      `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash)
       VALUES ($1, $2, 'reason', 'summary', $3) RETURNING id`,
      [taskId, REQUESTER_ADDRESS, "0x" + "d4".repeat(32)],
    );
    return dispute?.id ?? "";
  }

  it("arbitration_committee_members: an ACTIVE row can be inserted and enforces the ACTIVE/REMOVED field-pairing invariant", async () => {
    await pool.query(
      `INSERT INTO arbitration_committee_members (member_address, added_by) VALUES ($1, $2)`,
      [MEMBER_A, ADMIN_ADDRESS],
    );
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM arbitration_committee_members WHERE member_address = $1`,
      [MEMBER_A],
    );
    expect(rows[0]?.status).toBe("ACTIVE");

    await expect(
      pool.query(
        `INSERT INTO arbitration_committee_members (member_address, added_by, status, removed_by, removed_at)
         VALUES ($1, $2, 'REMOVED', NULL, NULL)`,
        [MEMBER_B, ADMIN_ADDRESS],
      ),
    ).rejects.toThrow(/removed_fields_match_status/);

    await expect(
      pool
        .query(
          `INSERT INTO arbitration_committee_members (member_address, added_by, status)
         VALUES ($1, $2, 'ACTIVE')` + ` RETURNING id`,
          [MEMBER_B, ADMIN_ADDRESS],
        )
        .then(({ rows: inserted }) =>
          pool.query(
            `UPDATE arbitration_committee_members SET removed_by = $1, removed_at = now() WHERE id = $2`,
            [ADMIN_ADDRESS, inserted[0]?.id],
          ),
        ),
    ).rejects.toThrow(/removed_fields_match_status/);
  });

  it("arbitration_committee_members: at most one ACTIVE row per address (re-adding a removed member is allowed)", async () => {
    await pool.query(
      `INSERT INTO arbitration_committee_members (member_address, added_by) VALUES ($1, $2)`,
      [MEMBER_A, ADMIN_ADDRESS],
    );
    await expect(
      pool.query(
        `INSERT INTO arbitration_committee_members (member_address, added_by) VALUES ($1, $2)`,
        [MEMBER_A, ADMIN_ADDRESS],
      ),
    ).rejects.toThrow(/unique_active_address/);

    await pool.query(
      `UPDATE arbitration_committee_members SET status = 'REMOVED', removed_by = $1, removed_at = now() WHERE member_address = $2`,
      [ADMIN_ADDRESS, MEMBER_A],
    );
    await expect(
      pool.query(
        `INSERT INTO arbitration_committee_members (member_address, added_by) VALUES ($1, $2)`,
        [MEMBER_A, ADMIN_ADDRESS],
      ),
    ).resolves.toBeDefined();
  });

  it("arbitration_upgrade_log: accepts a real-shaped rotation row and rejects a malformed tx hash", async () => {
    await pool.query(
      `INSERT INTO arbitration_upgrade_log (actor_address, from_arbitrator_address, to_arbitrator_address, tx_hash)
       VALUES ($1, $2, $3, $4)`,
      [ADMIN_ADDRESS, OLD_ARBITRATOR_ADDRESS, SAFE_ADDRESS, TX_HASH],
    );
    const { rows } = await pool.query(`SELECT * FROM arbitration_upgrade_log`);
    expect(rows).toHaveLength(1);

    await expect(
      pool.query(
        `INSERT INTO arbitration_upgrade_log (actor_address, from_arbitrator_address, to_arbitrator_address, tx_hash)
         VALUES ($1, $2, $3, 'not-a-hash')`,
        [ADMIN_ADDRESS, SAFE_ADDRESS, OLD_ARBITRATOR_ADDRESS],
      ),
    ).rejects.toThrow(/tx_hash_format/);
  });

  it("arbitration_decisions: real FK to disputes, and rejects fewer than two signers", async () => {
    const disputeId = await insertDispute();
    await pool.query(
      `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
       VALUES ($1, $2, $3, 'AGENT', $4)`,
      [disputeId, SAFE_TX_HASH, ONCHAIN_TX_HASH, [MEMBER_A, MEMBER_B]],
    );
    const { rows } = await pool.query(`SELECT * FROM arbitration_decisions WHERE dispute_id = $1`, [
      disputeId,
    ]);
    expect(rows).toHaveLength(1);

    await expect(
      pool.query(
        `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
         VALUES ($1, $2, $3, 'REQUESTER', $4)`,
        [disputeId, SAFE_TX_HASH, ONCHAIN_TX_HASH, [MEMBER_A]],
      ),
    ).rejects.toThrow(/at_least_two_distinct_valid_signers/);

    // N4 P1 fix (round 1): a real empty array must be rejected too — this
    // is exactly the case a bare `array_length(x, 1) >= 2` CHECK would
    // have silently accepted, since `array_length` of an empty array is
    // `NULL`, and a CHECK only rejects `false`, never `NULL`.
    await expect(
      pool.query(
        `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
         VALUES ($1, $2, $3, 'AGENT', $4)`,
        [disputeId, SAFE_TX_HASH, ONCHAIN_TX_HASH, []],
      ),
    ).rejects.toThrow(/at_least_two_distinct_valid_signers/);

    // A repeated address is not two REAL distinct signers.
    await expect(
      pool.query(
        `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
         VALUES ($1, $2, $3, 'AGENT', $4)`,
        [disputeId, SAFE_TX_HASH, ONCHAIN_TX_HASH, [MEMBER_A, MEMBER_A]],
      ),
    ).rejects.toThrow(/at_least_two_distinct_valid_signers/);

    // Two syntactically-invalid strings are not real addresses.
    await expect(
      pool.query(
        `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
         VALUES ($1, $2, $3, 'AGENT', $4)`,
        [disputeId, SAFE_TX_HASH, ONCHAIN_TX_HASH, ["not-an-address", "also-not-one"]],
      ),
    ).rejects.toThrow(/at_least_two_distinct_valid_signers/);

    // N4 P1 fix (round 2): a real address paired with a NULL array
    // element is NOT two real signers — `addr !~ regex` alone evaluates
    // to NULL (neither true nor false) for a NULL element, so this must
    // be rejected via an explicit `addr IS NULL` check, not the regex
    // comparison's own three-valued logic.
    await expect(
      pool.query(
        `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
         VALUES ($1, $2, $3, 'AGENT', $4)`,
        [disputeId, SAFE_TX_HASH, ONCHAIN_TX_HASH, [MEMBER_A, null]],
      ),
    ).rejects.toThrow(/at_least_two_distinct_valid_signers/);

    await expect(
      pool.query(
        `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
         VALUES ($1, $2, $3, 'AGENT', $4)`,
        [
          "00000000-0000-0000-0000-000000000000",
          SAFE_TX_HASH,
          ONCHAIN_TX_HASH,
          [MEMBER_A, MEMBER_B],
        ],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("rollback drops all three tables (and the signer-validation function), and the migration can be reapplied (up -> down -> up)", async () => {
    // N4 P2 fix (round 1): execute the REAL rollback file, not a
    // hand-copied duplicate of its SQL — otherwise a real defect in the
    // committed rollback file (a missing table, a wrong migration id, a
    // syntax error) would never be caught by this test.
    const rollbackPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0040_create_arbitration_committee_tables.rollback.sql",
    );
    const rollbackSql = readFileSync(rollbackPath, "utf8");
    await pool.query(rollbackSql);

    const { rows: afterDrop } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN ('arbitration_committee_members', 'arbitration_upgrade_log', 'arbitration_decisions')`,
    );
    expect(afterDrop).toHaveLength(0);

    const { rows: afterDropFn } = await pool.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname = 'arbitration_decisions_has_distinct_valid_signers'`,
    );
    expect(afterDropFn).toHaveLength(0);

    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0040_create_arbitration_committee_tables.sql"]);

    const { rows: afterReapply } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN ('arbitration_committee_members', 'arbitration_upgrade_log', 'arbitration_decisions')`,
    );
    expect(afterReapply.map((r) => r.table_name).sort()).toEqual([
      "arbitration_committee_members",
      "arbitration_decisions",
      "arbitration_upgrade_log",
    ]);
  });
});
