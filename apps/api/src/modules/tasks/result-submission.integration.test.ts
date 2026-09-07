import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "../chain/rpc.client.js";
import { RESULT_SUBMITTED_EVENT_ABI } from "@agent-market/domain";
import type { RawEventLog } from "@agent-market/domain";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import { verifyResultSubmission } from "./service.js";

// See funding.integration.test.ts's header comment (same pattern): skipped
// unless a human opts in with RUN_DB_INTEGRATION_TESTS=1 against a
// confirmed-safe TEST_DATABASE_URL. This suite is T-905's dedicated
// verification of `verifyResultSubmission` (tasks/service.ts) — a real
// PostgreSQL pool, a fake `ChainRpcClient` standing in for a real chain
// node, mirroring exactly how acceptance.integration.test.ts exercises
// `verifyAcceptance`.
//
// AC-906/AC-908 are this suite's specific focus: repeated delivery of the
// same result-submission transaction must not produce duplicate
// SUBMITTED writes (idempotent), and `tasks.submitted_at`/`review_deadline`
// must equal the decoded event's fields EXACTLY (verbatim projection, no
// `+ reviewWindow` computation anywhere in this codepath).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";
const TASK_BUDGET = "1000";

const SUBMITTED_AT = 1_800_000_000n;
const REVIEW_DEADLINE = SUBMITTED_AT + 259_200n;

function buildResultSubmittedLog(params: {
  taskIdOnChain: `0x${string}`;
  agent: `0x${string}`;
  resultHash?: `0x${string}`;
  submittedAt?: bigint;
  reviewDeadline?: bigint;
  address?: `0x${string}`;
}): RawEventLog {
  const resultHash = params.resultHash ?? (("0x" + "e".repeat(64)) as `0x${string}`);
  const submittedAt = params.submittedAt ?? SUBMITTED_AT;
  const reviewDeadline = params.reviewDeadline ?? REVIEW_DEADLINE;
  const topics = encodeEventTopics({
    abi: RESULT_SUBMITTED_EVENT_ABI,
    eventName: "ResultSubmitted",
    args: { taskId: params.taskIdOnChain, agent: getAddress(params.agent) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "resultHash", type: "bytes32" },
      { name: "submittedAt", type: "uint64" },
      { name: "reviewDeadline", type: "uint64" },
    ],
    [resultHash, submittedAt, reviewDeadline],
  );
  return {
    address: params.address ?? (TASK_ESCROW_ADDRESS as `0x${string}`),
    topics,
    data,
    logIndex: 0,
  };
}

interface FakeRpcOptions {
  receipt?: TransactionReceiptResult | null;
  chainId?: number;
  currentBlockNumber?: bigint;
  canonicalBlock?: BlockResult | null;
  throwOnReceipt?: Error;
}

function buildFakeRpc(options: FakeRpcOptions = {}): ChainRpcClient {
  const {
    receipt = null,
    chainId = Number(TEST_CHAIN_ID),
    currentBlockNumber = 100n,
    canonicalBlock = { hash: "0x" + "b".repeat(64), number: 100n },
    throwOnReceipt,
  } = options;
  return {
    async getTransactionReceipt() {
      if (throwOnReceipt) {
        throw throwOnReceipt;
      }
      return receipt;
    },
    async getBlockNumber() {
      return currentBlockNumber;
    },
    async getBlock() {
      return canonicalBlock;
    },
    async getChainId() {
      return chainId;
    },
    async getTransaction() {
      throw new Error("getTransaction: not used by verifyResultSubmission");
    },
    async readStakeRateBps() {
      throw new Error("readStakeRateBps: not used by verifyResultSubmission");
    },
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by verifyResultSubmission");
    },
    async readHasRole() {
      throw new Error("readHasRole: not used by verifyResultSubmission");
    },
  };
}

runIfOptedIn("verifyResultSubmission (integration, T-905)", () => {
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
    await pool.query("DELETE FROM deliverables");
    await pool.query("DELETE FROM task_state_history");
    await pool.query("DELETE FROM chain_events");
    await pool.query("DELETE FROM chain_transactions");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM users");
  });

  async function insertAcceptedTask(): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_address, accepted_at, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', $2, $3, '2099-01-01T00:00:00Z', 'ACCEPTED', $4, now(), 'AUTOMATION')
       RETURNING id`,
      [requester.address.toLowerCase(), TASK_BUDGET, YD_TOKEN_ADDRESS, agent.address.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAcceptedTask: no id returned");
    return id;
  }

  it("transitions ACCEPTED -> SUBMITTED and writes submitted_at/review_deadline verbatim from the event (AC-908)", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "1".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      receipt: {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [buildResultSubmittedLog({ taskIdOnChain, agent: agent.address as `0x${string}` })],
      },
    });

    const result = await verifyResultSubmission(pool, rpc, agent.address, taskId, txHash);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.status).toBe("SUBMITTED");

    const { rows } = await pool.query<{
      status: string;
      submitted_at: Date;
      review_deadline: Date;
    }>(`SELECT status, submitted_at, review_deadline FROM tasks WHERE id = $1`, [taskId]);
    expect(rows[0]?.status).toBe("SUBMITTED");
    // Exact equality with the decoded event's own unix-second values,
    // converted to Date the same (and only) way this codebase does it —
    // no computed offset, no reviewWindow arithmetic (AC-908).
    expect(rows[0]?.submitted_at.getTime()).toBe(Number(SUBMITTED_AT) * 1000);
    expect(rows[0]?.review_deadline.getTime()).toBe(Number(REVIEW_DEADLINE) * 1000);

    // F-1901 (T-1901): a real SUBMIT event is written to the outbox
    // atomically with the result submission itself.
    const outboxEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE aggregate_type = 'task' AND aggregate_id = $1`,
      [taskId],
    );
    expect(outboxEvents.rows).toHaveLength(1);
    expect(outboxEvents.rows[0]?.event_type).toBe("SUBMIT");
  });

  it("records a chain_events row with eventName ResultSubmitted and the decoded payload", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "2".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      receipt: {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [buildResultSubmittedLog({ taskIdOnChain, agent: agent.address as `0x${string}` })],
      },
    });

    await verifyResultSubmission(pool, rpc, agent.address, taskId, txHash);

    const { rows } = await pool.query<{ event_name: string; payload: Record<string, unknown> }>(
      `SELECT event_name, payload FROM chain_events WHERE task_id = $1`,
      [taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_name).toBe("ResultSubmitted");
    expect(String(rows[0]?.payload.agent).toLowerCase()).toBe(agent.address.toLowerCase());
  });

  it("is idempotent: resubmitting the same txHash after SUBMITTED does not error and does not duplicate chain_events (AC-906)", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "3".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      receipt: {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [buildResultSubmittedLog({ taskIdOnChain, agent: agent.address as `0x${string}` })],
      },
    });

    const first = await verifyResultSubmission(pool, rpc, agent.address, taskId, txHash);
    expect(first.ok).toBe(true);

    const second = await verifyResultSubmission(pool, rpc, agent.address, taskId, txHash);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok:true");
    expect(second.status).toBe("SUBMITTED");

    const { rows } = await pool.query(`SELECT * FROM chain_events WHERE task_id = $1`, [taskId]);
    expect(rows).toHaveLength(1);
  });

  it("returns conflict when a STRANGER resubmits the already-mined result-submission txHash", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "4".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      receipt: {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [buildResultSubmittedLog({ taskIdOnChain, agent: agent.address as `0x${string}` })],
      },
    });

    await verifyResultSubmission(pool, rpc, agent.address, taskId, txHash);

    const stranger = privateKeyToAccount(generatePrivateKey());
    const result = await verifyResultSubmission(pool, rpc, stranger.address, taskId, txHash);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("conflict");
  });

  it("returns conflict when the task is not ACCEPTED (e.g. still OPEN)", async () => {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', $2, $3, '2099-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [requester.address.toLowerCase(), TASK_BUDGET, YD_TOKEN_ADDRESS],
    );
    const taskId = rows[0]?.id;
    if (!taskId) throw new Error("no id returned");

    const rpc = buildFakeRpc();
    const result = await verifyResultSubmission(
      pool,
      rpc,
      agent.address,
      taskId,
      ("0x" + "5".repeat(64)) as `0x${string}`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("conflict");
  });

  it("returns chain_error/FUNDING_EVENT_MISMATCH when the decoded event's agent does not match the submitting session address", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const rpc = buildFakeRpc({
      receipt: {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        // Event carries `agent`'s address, but the SESSION submitting is `stranger`.
        logs: [buildResultSubmittedLog({ taskIdOnChain, agent: agent.address as `0x${string}` })],
      },
    });

    const result = await verifyResultSubmission(
      pool,
      rpc,
      stranger.address,
      taskId,
      ("0x" + "6".repeat(64)) as `0x${string}`,
    );

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "chain_error") {
      throw new Error("expected ok:false, reason:chain_error");
    }
    expect(result.code).toBe("FUNDING_EVENT_MISMATCH");
  });

  it("returns not_found for a nonexistent task", async () => {
    const rpc = buildFakeRpc();
    const result = await verifyResultSubmission(
      pool,
      rpc,
      agent.address,
      "00000000-0000-4000-8000-000000000000",
      ("0x" + "7".repeat(64)) as `0x${string}`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("not_found");
  });
});
