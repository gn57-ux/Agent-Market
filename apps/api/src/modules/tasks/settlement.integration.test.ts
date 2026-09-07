import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "../chain/rpc.client.js";
import { RESULT_APPROVED_EVENT_ABI } from "@agent-market/domain";
import { DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI } from "@agent-market/domain";
import { REVIEW_TIMEOUT_FINALIZED_EVENT_ABI } from "@agent-market/domain";
import type { RawEventLog } from "@agent-market/domain";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import { verifySettlement } from "./service.js";

/**
 * See result-submission.integration.test.ts's header comment (same
 * pattern): skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1
 * against a confirmed-safe TEST_DATABASE_URL. T-1001's dedicated
 * verification of `verifySettlement` (tasks/service.ts) — AC-1001/AC-1002
 * (all three settlement transitions actually happen and pay the right
 * status), AC-1005 (idempotent — repeated delivery of the same tx does not
 * double-count), and AC-1008 (this codepath never touches
 * `agents.quality_score`, only `completed_task_count`/`success_count`/
 * `overdue_count`).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";
const TASK_BUDGET = "1000";
const SETTLEMENT_BUDGET = 1_000_000_000_000_000_000_000n;
const SETTLEMENT_STAKE = 60_000_000_000_000_000_000n;

function buildResultApprovedLog(taskIdOnChain: `0x${string}`, agent: `0x${string}`): RawEventLog {
  const topics = encodeEventTopics({
    abi: RESULT_APPROVED_EVENT_ABI,
    eventName: "ResultApproved",
    args: { taskId: taskIdOnChain, agent: getAddress(agent) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [SETTLEMENT_BUDGET, SETTLEMENT_STAKE],
  );
  return { address: TASK_ESCROW_ADDRESS, topics, data, logIndex: 0 };
}

function buildDeliveryTimeoutClaimedLog(
  taskIdOnChain: `0x${string}`,
  requester: `0x${string}`,
): RawEventLog {
  const topics = encodeEventTopics({
    abi: DELIVERY_TIMEOUT_CLAIMED_EVENT_ABI,
    eventName: "DeliveryTimeoutClaimed",
    args: { taskId: taskIdOnChain, requester: getAddress(requester) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [SETTLEMENT_BUDGET, SETTLEMENT_STAKE],
  );
  return { address: TASK_ESCROW_ADDRESS, topics, data, logIndex: 0 };
}

function buildReviewTimeoutFinalizedLog(
  taskIdOnChain: `0x${string}`,
  agent: `0x${string}`,
): RawEventLog {
  const topics = encodeEventTopics({
    abi: REVIEW_TIMEOUT_FINALIZED_EVENT_ABI,
    eventName: "ReviewTimeoutFinalized",
    args: { taskId: taskIdOnChain, agent: getAddress(agent) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "budget", type: "uint256" },
      { name: "stake", type: "uint256" },
    ],
    [SETTLEMENT_BUDGET, SETTLEMENT_STAKE],
  );
  return { address: TASK_ESCROW_ADDRESS, topics, data, logIndex: 0 };
}

function buildFakeRpc(receipt: TransactionReceiptResult | null): ChainRpcClient {
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
    async getTransaction() {
      throw new Error("getTransaction: not used by verifySettlement");
    },
    async readStakeRateBps() {
      throw new Error("readStakeRateBps: not used by verifySettlement");
    },
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by verifySettlement");
    },
    async readHasRole() {
      throw new Error("readHasRole: not used by verifySettlement");
    },
  };
}

runIfOptedIn("verifySettlement (integration, T-1001)", () => {
  let pool: Pool;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());

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

  async function insertTaskWithStatus(status: "ACCEPTED" | "SUBMITTED"): Promise<{
    taskId: string;
    agentId: string;
  }> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
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

  it("ResultApproved: SUBMITTED -> RELEASED, completed+1/success+1/overdue+0, quality_score untouched (AC-1001, AC-1005, AC-1008)", async () => {
    const { taskId, agentId } = await insertTaskWithStatus("SUBMITTED");
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "1".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildResultApprovedLog(taskIdOnChain, agent.address as `0x${string}`)],
    });

    const result = await verifySettlement(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "RELEASED", confirmations: 1 });

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("RELEASED");

    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });

    // AC-1005: repeated delivery of the SAME tx must not double-count.
    const replay = await verifySettlement(pool, rpc, taskId, txHash);
    expect(replay).toEqual({ ok: true, status: "RELEASED", confirmations: 1 });
    const statsAfterReplay = await agentStats(agentId);
    expect(statsAfterReplay).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });

    // F-1901 (T-1901): a real APPROVE event is written to the outbox
    // atomically with the fund release — exactly once, even after the
    // idempotent replay above.
    const outboxEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE aggregate_type = 'task' AND aggregate_id = $1`,
      [taskId],
    );
    expect(outboxEvents.rows).toHaveLength(1);
    expect(outboxEvents.rows[0]?.event_type).toBe("APPROVE");
  });

  it("DeliveryTimeoutClaimed: ACCEPTED -> REFUNDED, completed+1/overdue+1/success+0 (AC-1002, AC-1005)", async () => {
    const { taskId, agentId } = await insertTaskWithStatus("ACCEPTED");
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "2".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildDeliveryTimeoutClaimedLog(taskIdOnChain, requester.address as `0x${string}`)],
    });

    const result = await verifySettlement(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "REFUNDED", confirmations: 1 });

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("REFUNDED");

    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 0, overdue: 1, qualityScore: null });

    // F-1901 (T-1901): a real REFUND event is written to the outbox
    // atomically with this settlement path (DeliveryTimeoutClaimed).
    const outboxEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE aggregate_type = 'task' AND aggregate_id = $1`,
      [taskId],
    );
    expect(outboxEvents.rows).toHaveLength(1);
    expect(outboxEvents.rows[0]?.event_type).toBe("REFUND");
  });

  it("ReviewTimeoutFinalized: SUBMITTED -> RELEASED, completed+1/success+1/overdue+0 (AC-1002, AC-1005)", async () => {
    const { taskId, agentId } = await insertTaskWithStatus("SUBMITTED");
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "3".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildReviewTimeoutFinalizedLog(taskIdOnChain, agent.address as `0x${string}`)],
    });

    const result = await verifySettlement(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "RELEASED", confirmations: 1 });

    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });
  });

  it("rejects a DeliveryTimeoutClaimed event for a task that is not ACCEPTED (conflict)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "4".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildDeliveryTimeoutClaimedLog(taskIdOnChain, requester.address as `0x${string}`)],
    });

    const result = await verifySettlement(pool, rpc, taskId, txHash);
    expect(result).toEqual({ ok: false, reason: "conflict", currentStatus: "SUBMITTED" });
  });

  it("returns not_found for a nonexistent task", async () => {
    const rpc = buildFakeRpc(null);
    const result = await verifySettlement(
      pool,
      rpc,
      "00000000-0000-4000-8000-000000000000",
      ("0x" + "5".repeat(64)) as `0x${string}`,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("does not transition when the receipt is not yet available (routine, not an error)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const txHash = ("0x" + "6".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc(null);

    const result = await verifySettlement(pool, rpc, taskId, txHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain_error");

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("SUBMITTED");
  });
});
