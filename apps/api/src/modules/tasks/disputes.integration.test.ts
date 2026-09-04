import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "../chain/rpc.client.js";
import { DISPUTE_OPENED_EVENT_ABI } from "@agent-market/domain";
import { DISPUTE_RESOLVED_EVENT_ABI } from "@agent-market/domain";
import type { RawEventLog } from "@agent-market/domain";
import { computeEvidenceHash } from "../disputes/evidence-hash.js";
import { insertDispute, getDisputeForTask } from "../disputes/repository.js";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import { verifyDisputeOpen, verifyDisputeResolution } from "./service.js";

/**
 * Real-DB integration test for T-1002's disputes flow, mirroring
 * settlement.integration.test.ts's own pattern: skipped unless a human
 * opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
 * TEST_DATABASE_URL. Covers AC-1003 (a submitted DisputeOpened tx moves
 * SUBMITTED -> DISPUTED and cross-checks the recorded evidence hash),
 * AC-1003's arbitration half (DisputeResolved moves DISPUTED -> RELEASED
 * or REFUNDED per `supportAgent`), AC-1005 (idempotent replay for both
 * steps), the `disputes_task_id_unique_open` constraint (a second open
 * dispute submission is rejected), the `audit_logs` write, and AC-1008
 * (dispute resolution never touches `agents.quality_score`, and
 * REFUNDED-via-dispute must NOT increment `overdue_count` the way a
 * DeliveryTimeoutClaimed refund does).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE";

const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";
const TASK_BUDGET = "1000";

function buildDisputeOpenedLog(
  taskIdOnChain: `0x${string}`,
  requester: `0x${string}`,
  evidenceHash: `0x${string}`,
): RawEventLog {
  const topics = encodeEventTopics({
    abi: DISPUTE_OPENED_EVENT_ABI,
    eventName: "DisputeOpened",
    args: { taskId: taskIdOnChain, requester: getAddress(requester) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [{ name: "disputeEvidenceHash", type: "bytes32" }],
    [evidenceHash],
  );
  return { address: TASK_ESCROW_ADDRESS, topics, data, logIndex: 0 };
}

function buildDisputeResolvedLog(taskIdOnChain: `0x${string}`, supportAgent: boolean): RawEventLog {
  const topics = encodeEventTopics({
    abi: DISPUTE_RESOLVED_EVENT_ABI,
    eventName: "DisputeResolved",
    args: { taskId: taskIdOnChain },
  }) as readonly string[];
  const data = encodeAbiParameters([{ name: "supportAgent", type: "bool" }], [supportAgent]);
  return { address: TASK_ESCROW_ADDRESS, topics, data, logIndex: 0 };
}

runIfOptedIn("disputes flow (integration, T-1002)", () => {
  let pool: Pool;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const arbitrator = privateKeyToAccount(generatePrivateKey());

  function buildFakeRpc(
    receipt: TransactionReceiptResult | null,
    transactionFrom: `0x${string}` = arbitrator.address as `0x${string}`,
  ): ChainRpcClient {
    const canonicalBlock: BlockResult = { hash: "0x" + "b".repeat(64), number: 100n };
    return {
      async getTransactionReceipt() {
        return receipt;
      },
      async getBlockNumber() {
        return 100n;
      },
      async getBlock() {
        return canonicalBlock;
      },
      async getChainId() {
        return Number(TEST_CHAIN_ID);
      },
      // Only verifyDisputeResolution reads this (to independently derive
      // the real arbitrator address from the tx's own sender — Codex
      // review, T-1002 round 1, P1); verifyDisputeOpen never calls
      // getTransaction.
      async getTransaction() {
        return { input: "0x", from: transactionFrom };
      },
      async readStakeRateBps() {
        throw new Error("readStakeRateBps: not used by verifyDisputeOpen/verifyDisputeResolution");
      },
      async readAuthorizedSigner() {
        throw new Error(
          "readAuthorizedSigner: not used by verifyDisputeOpen/verifyDisputeResolution",
        );
      },
      async readHasRole() {
        throw new Error("readHasRole: not used by verifyDisputeOpen/verifyDisputeResolution");
      },
    };
  }

  beforeAll(async () => {
    process.env.CHAIN_ID = TEST_CHAIN_ID;
    process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
    process.env.YD_TOKEN_ADDRESS = YD_TOKEN_ADDRESS;
    process.env.YD_FAUCET_ADDRESS = YD_FAUCET_ADDRESS;
    delete process.env.FUNDING_REQUIRED_CONFIRMATIONS; // default: 1

    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM audit_logs");
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM task_state_history");
    await pool.query("DELETE FROM chain_events");
    await pool.query("DELETE FROM chain_transactions");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM users");
  });

  async function insertAgentRow(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [agent.address.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgentRow: no id returned");
    return id;
  }

  async function insertTaskWithStatus(status: "SUBMITTED" | "DISPUTED"): Promise<{
    taskId: string;
    agentId: string;
  }> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2), ($3) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
      arbitrator.address.toLowerCase(),
    ]);
    const agentId = await insertAgentRow();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline,
          status, accepted_agent_address, accepted_agent_id, accepted_at, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', $2, $3, '2099-01-01T00:00:00Z', $4, $5, $6, now(), 'AUTOMATION')
       RETURNING id`,
      [
        requester.address.toLowerCase(),
        TASK_BUDGET,
        YD_TOKEN_ADDRESS,
        status,
        agent.address.toLowerCase(),
        agentId,
      ],
    );
    const taskId = rows[0]?.id;
    if (!taskId) throw new Error("insertTaskWithStatus: no id returned");
    return { taskId, agentId };
  }

  async function agentStats(
    agentId: string,
  ): Promise<{ completed: number; success: number; overdue: number; qualityScore: number | null }> {
    const { rows } = await pool.query<{
      completed_task_count: number;
      success_count: number;
      overdue_count: number;
      quality_score: number | null;
    }>(
      `SELECT completed_task_count, success_count, overdue_count, quality_score
       FROM agents WHERE id = $1`,
      [agentId],
    );
    const row = rows[0];
    if (!row) throw new Error("agentStats: agent not found");
    return {
      completed: row.completed_task_count,
      success: row.success_count,
      overdue: row.overdue_count,
      qualityScore: row.quality_score,
    };
  }

  it("openDispute: SUBMITTED -> DISPUTED, cross-checks the recorded evidence hash, idempotent replay (AC-1003, AC-1005)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const evidenceHash = computeEvidenceHash("the deliverable does not meet the agreed spec");
    const dispute = await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "quality dispute",
      evidenceSummary: "the deliverable does not meet the agreed spec",
      evidenceHash,
    });
    expect(dispute).not.toBeNull();

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "1".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [
        buildDisputeOpenedLog(taskIdOnChain, requester.address as `0x${string}`, evidenceHash),
      ],
    });

    const result = await verifyDisputeOpen(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "DISPUTED", confirmations: 1 });

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("DISPUTED");

    // AC-1005: replaying the same tx must not error and must not re-transition.
    const replay = await verifyDisputeOpen(pool, rpc, taskId, txHash);
    expect(replay).toEqual({ ok: true, status: "DISPUTED", confirmations: 1 });
  });

  it("rejects a DisputeOpened event whose on-chain evidenceHash does not match the recorded dispute", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const recordedHash = computeEvidenceHash("recorded evidence");
    await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "quality dispute",
      evidenceSummary: "recorded evidence",
      evidenceHash: recordedHash,
    });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "2".repeat(64)) as `0x${string}`;
    const wrongHash = ("0x" + "d".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildDisputeOpenedLog(taskIdOnChain, requester.address as `0x${string}`, wrongHash)],
    });

    const result = await verifyDisputeOpen(pool, rpc, taskId, txHash);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "chain_error") {
      expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
    } else {
      throw new Error(`expected chain_error, got ${JSON.stringify(result)}`);
    }

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("SUBMITTED");
  });

  it("refuses to transition when no OPEN dispute row exists for the task", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "3".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [
        buildDisputeOpenedLog(
          taskIdOnChain,
          requester.address as `0x${string}`,
          computeEvidenceHash("anything"),
        ),
      ],
    });

    const result = await verifyDisputeOpen(pool, rpc, taskId, txHash);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "chain_error") {
      expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
    } else {
      throw new Error(`expected chain_error, got ${JSON.stringify(result)}`);
    }
  });

  it("insertDispute rejects a second OPEN dispute for the same task (disputes_task_id_unique_open)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const first = await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "first",
      evidenceSummary: "first evidence",
      evidenceHash: computeEvidenceHash("first evidence"),
    });
    expect(first).not.toBeNull();

    const second = await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "second",
      evidenceSummary: "second evidence",
      evidenceHash: computeEvidenceHash("second evidence"),
    });
    expect(second).toBeNull();
  });

  it("resolveDispute(supportAgent=true): DISPUTED -> RELEASED, completed+1/success+1/overdue+0, quality_score untouched, disputes+audit_logs written (AC-1003, AC-1005, AC-1008)", async () => {
    const { taskId, agentId } = await insertTaskWithStatus("DISPUTED");
    const evidenceHash = computeEvidenceHash("evidence");
    await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "quality dispute",
      evidenceSummary: "evidence",
      evidenceHash,
    });
    // The dispute row must be OPEN going into resolution; insertDispute
    // above already leaves it OPEN (status defaults to OPEN).

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "4".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildDisputeResolvedLog(taskIdOnChain, true)],
    });

    const result = await verifyDisputeResolution(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "RELEASED", confirmations: 1 });

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("RELEASED");

    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });

    const disputeRow = await getDisputeForTask(pool, taskId);
    expect(disputeRow?.status).toBe("RESOLVED");
    expect(disputeRow?.resolution).toBe("SUPPORT_AGENT");
    expect(disputeRow?.resolvedBy).toBe(arbitrator.address.toLowerCase());

    const { rows: auditRows } = await pool.query<{ action: string; actor_address: string }>(
      `SELECT action, actor_address FROM audit_logs WHERE task_id = $1`,
      [taskId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("DISPUTE_RESOLVED");
    expect(auditRows[0]?.actor_address).toBe(arbitrator.address.toLowerCase());

    // AC-1005: idempotent replay.
    const replay = await verifyDisputeResolution(pool, rpc, taskId, txHash);
    expect(replay).toEqual({ ok: true, status: "RELEASED", confirmations: 1 });
    const statsAfterReplay = await agentStats(agentId);
    expect(statsAfterReplay).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });
  });

  it("resolveDispute(supportAgent=false): DISPUTED -> REFUNDED, completed+1/success+0/overdue+0 — NOT overdue+1 (AC-1003, AC-1008)", async () => {
    const { taskId, agentId } = await insertTaskWithStatus("DISPUTED");
    const evidenceHash = computeEvidenceHash("evidence");
    await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "quality dispute",
      evidenceSummary: "evidence",
      evidenceHash,
    });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "5".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildDisputeResolvedLog(taskIdOnChain, false)],
    });

    const result = await verifyDisputeResolution(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "REFUNDED", confirmations: 1 });

    const stats = await agentStats(agentId);
    // Critical distinction (F-1006): a dispute-driven refund must NOT
    // increment overdue_count the way a DeliveryTimeoutClaimed refund does.
    expect(stats).toEqual({ completed: 1, success: 0, overdue: 0, qualityScore: null });

    const disputeRow = await getDisputeForTask(pool, taskId);
    expect(disputeRow?.status).toBe("RESOLVED");
    expect(disputeRow?.resolution).toBe("SUPPORT_REQUESTER");
  });

  it("upserts a users row for an arbitrator address that never logged into this backend before (resolved_by FK)", async () => {
    const { taskId } = await insertTaskWithStatus("DISPUTED");
    const evidenceHash = computeEvidenceHash("evidence");
    await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "quality dispute",
      evidenceSummary: "evidence",
      evidenceHash,
    });

    const unknownArbitrator = privateKeyToAccount(generatePrivateKey());
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "9".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc(
      {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [buildDisputeResolvedLog(taskIdOnChain, true)],
      },
      unknownArbitrator.address as `0x${string}`,
    );

    const result = await verifyDisputeResolution(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "RELEASED", confirmations: 1 });

    const disputeRow = await getDisputeForTask(pool, taskId);
    expect(disputeRow?.resolvedBy).toBe(unknownArbitrator.address.toLowerCase());

    const { rows } = await pool.query<{ address: string }>(
      `SELECT address FROM users WHERE address = $1`,
      [unknownArbitrator.address.toLowerCase()],
    );
    expect(rows).toHaveLength(1);
  });

  // Codex review (T-1005 evidence package round 2, P1 — routed to this
  // Task's own lineage, the DISPUTED->RELEASED/REFUNDED settlement path
  // T-1002 originally implemented): `resolveDisputeRow`'s boolean return
  // used to be discarded, so a task whose `tasks.status` says DISPUTED but
  // whose `disputes` row is missing/already-resolved (a genuine data
  // inconsistency — never expected in normal operation, but must not
  // silently commit past) would still have its settlement transaction
  // commit: status flips to RELEASED/REFUNDED, agent stats bump,
  // chain_transactions/chain_events/audit_logs all get written — with NO
  // resolved dispute row underneath any of it. This constructs that exact
  // real-DB fault (a DISPUTED task with NO dispute row at all, never
  // mocking `resolveDisputeRow` itself) and proves the whole transaction
  // now rolls back atomically instead.
  it("rolls back the entire settlement transaction when no OPEN dispute row exists for a DISPUTED task (data-integrity fault injection)", async () => {
    const { taskId, agentId } = await insertTaskWithStatus("DISPUTED");
    // Deliberately no `insertDispute` call — `disputes` has zero rows for
    // this task, reproducing `resolveDisputeRow`'s `false` return through
    // real DB state, not a mock.

    const statsBefore = await agentStats(agentId);

    // A NEVER-before-seen arbitrator address (not `arbitrator`, which
    // `insertTaskWithStatus` already inserted into `users` as part of its
    // own setup — using it would make a rollback of the `users` upsert
    // unobservable, since the row would exist before AND after regardless
    // of whether the upsert itself was rolled back). Mirrors the existing
    // "upserts a users row for an arbitrator address that never logged into
    // this backend before" test's own `unknownArbitrator` pattern.
    const unknownArbitrator = privateKeyToAccount(generatePrivateKey());
    const arbitratorAddress = unknownArbitrator.address.toLowerCase();

    const { rows: usersBefore } = await pool.query<{ address: string }>(
      `SELECT address FROM users WHERE address = $1`,
      [arbitratorAddress],
    );
    expect(usersBefore).toHaveLength(0);

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "a".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc(
      {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [buildDisputeResolvedLog(taskIdOnChain, true)],
      },
      unknownArbitrator.address as `0x${string}`,
    );

    const result = await verifyDisputeResolution(pool, rpc, taskId, txHash);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "chain_error") {
      expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
    } else {
      throw new Error(`expected chain_error, got ${JSON.stringify(result)}`);
    }

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("DISPUTED");

    const statsAfter = await agentStats(agentId);
    expect(statsAfter).toEqual(statsBefore);

    const disputeRow = await getDisputeForTask(pool, taskId);
    expect(disputeRow).toBeNull();

    const { rows: txRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chain_transactions WHERE task_id = $1`,
      [taskId],
    );
    expect(txRows[0]?.count).toBe("0");

    const { rows: eventRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chain_events WHERE task_id = $1`,
      [taskId],
    );
    expect(eventRows[0]?.count).toBe("0");

    const { rows: auditRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE task_id = $1`,
      [taskId],
    );
    expect(auditRows[0]?.count).toBe("0");

    // The `users` upsert runs INSIDE the same transaction, BEFORE
    // `resolveDisputeRow` — proving it did not silently commit ahead of the
    // throw is the direct evidence that the whole transaction rolled back
    // atomically, not merely that its later statements never ran.
    const { rows: usersAfter } = await pool.query<{ address: string }>(
      `SELECT address FROM users WHERE address = $1`,
      [arbitratorAddress],
    );
    expect(usersAfter).toHaveLength(0);
  });

  it("rejects DisputeResolved for a task that is not DISPUTED (conflict)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "6".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildDisputeResolvedLog(taskIdOnChain, true)],
    });

    const result = await verifyDisputeResolution(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: false, reason: "conflict", currentStatus: "SUBMITTED" });
  });

  it("returns not_found for a nonexistent task on both openDispute and resolveDispute verification", async () => {
    const rpc = buildFakeRpc(null);
    const openResult = await verifyDisputeOpen(
      pool,
      rpc,
      "00000000-0000-4000-8000-000000000000",
      ("0x" + "7".repeat(64)) as `0x${string}`,
    );
    expect(openResult).toEqual({ ok: false, reason: "not_found" });

    const resolveResult = await verifyDisputeResolution(
      pool,
      rpc,
      "00000000-0000-4000-8000-000000000001",
      ("0x" + "8".repeat(64)) as `0x${string}`,
    );
    expect(resolveResult).toEqual({ ok: false, reason: "not_found" });
  });
});
