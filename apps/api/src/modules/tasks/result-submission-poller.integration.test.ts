import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "../chain/rpc.client.js";
import { RESULT_SUBMITTED_EVENT_ABI } from "@agent-market/domain";
import type {
  ResultSubmittedLogEntry,
  ResultSubmittedLogScanner,
} from "../chain/result-submitted-log-scanner.js";
import type { RawEventLog } from "@agent-market/domain";

// Mocked BEFORE importing result-submission-poller.js (vi.mock calls are
// hoisted to the top of the file by Vitest) — same technique
// routes.cleanup.integration.test.ts already uses: `verifyResultSubmission`
// is overridden ONLY for the one "poison" taskId this file's error-
// collection test designates, delegating to the REAL implementation
// (`importOriginal`) for every other call, so every other test in this
// file still exercises the genuine end-to-end write path.
let poisonTaskId: string | undefined;
vi.mock("./service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service.js")>();
  return {
    ...actual,
    verifyResultSubmission: (
      ...args: Parameters<typeof actual.verifyResultSubmission>
    ): ReturnType<typeof actual.verifyResultSubmission> => {
      const [, , , taskId] = args;
      if (taskId === poisonTaskId) {
        throw new Error("simulated unexpected failure for this one task");
      }
      return actual.verifyResultSubmission(...args);
    },
  };
});

const { runMigrations } = await import("../../db/migrate.js");
const { requireTestDatabaseUrl } = await import("@agent-market/domain");
const { deriveOnChainTaskId } = await import("./onchain-task-id.js");
const { pollResultSubmittedEvents } = await import("./result-submission-poller.js");

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite is T-905's dedicated verification of
// `pollResultSubmittedEvents` — the actual event-consumption entry point
// (N4 round 1 P1, Codex): proves a `ResultSubmitted` transaction gets
// synced to `SUBMITTED` WITHOUT any client ever calling
// `POST /tasks/:taskId/result-verifications`, using only the scanner +
// currently-ACCEPTED-tasks snapshot this function itself drives.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE";

const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";
const TASK_BUDGET = "1000";
const SUBMITTED_AT = 1_800_000_000n;
const REVIEW_DEADLINE = SUBMITTED_AT + 259_200n;

function buildResultSubmittedLog(params: {
  taskIdOnChain: `0x${string}`;
  agent: `0x${string}`;
}): RawEventLog {
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
    [("0x" + "e".repeat(64)) as `0x${string}`, SUBMITTED_AT, REVIEW_DEADLINE],
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
      throw new Error("getTransaction: not used by the poller path");
    },
    async readStakeRateBps() {
      throw new Error("readStakeRateBps: not used by the poller path");
    },
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by the poller path");
    },
    async readHasRole() {
      throw new Error("readHasRole: not used by the poller path");
    },
  };
}

/**
 * Builds a full `ResultSubmittedLogEntry` (T-905 round B: the scanner's
 * return shape was widened to carry the decoded event + block/log identity
 * directly, so the discovery pass can populate a `pending_result_submissions`
 * row without a second RPC round-trip). Defaults `blockNumber` to `100n` —
 * matching `buildFakeRpc`'s `getBlockNumber()`/canonical-block height — so
 * `confirmations = currentBlock - blockNumber + 1n` is `1`, already at
 * `DEFAULT_REQUIRED_CONFIRMATIONS` (1), meaning a freshly-discovered entry
 * is immediately eligible for the SAME tick's promotion pass unless a test
 * explicitly overrides `blockNumber` to something less confirmed.
 */
function buildScannerEntry(params: {
  taskId: `0x${string}`;
  transactionHash: `0x${string}`;
  agent: `0x${string}`;
  blockNumber?: bigint;
  blockHash?: `0x${string}`;
  logIndex?: number;
}): ResultSubmittedLogEntry {
  return {
    taskId: params.taskId,
    transactionHash: params.transactionHash,
    logIndex: params.logIndex ?? 0,
    blockHash: params.blockHash ?? (("0x" + "b".repeat(64)) as `0x${string}`),
    blockNumber: params.blockNumber ?? 100n,
    agent: params.agent,
  };
}

function buildFakeScanner(entries: ResultSubmittedLogEntry[]): ResultSubmittedLogScanner {
  return {
    async scanResultSubmittedLogs() {
      return entries;
    },
  };
}

runIfOptedIn("pollResultSubmittedEvents (integration, T-905)", () => {
  let pool: Pool;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    process.env.CHAIN_ID = TEST_CHAIN_ID;
    process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
    process.env.YD_TOKEN_ADDRESS = YD_TOKEN_ADDRESS;
    process.env.YD_FAUCET_ADDRESS = YD_FAUCET_ADDRESS;
    delete process.env.FUNDING_REQUIRED_CONFIRMATIONS;

    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    poisonTaskId = undefined;
    await pool.query("DELETE FROM pending_result_submissions");
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

  it("transitions a task to SUBMITTED purely from a scanned log — no client ever calls the HTTP endpoint (the P1 fix itself)", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "1".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildResultSubmittedLog({ taskIdOnChain, agent: agent.address as `0x${string}` })],
    });
    const scanner = buildFakeScanner([
      buildScannerEntry({
        taskId: taskIdOnChain,
        transactionHash: txHash,
        agent: agent.address as `0x${string}`,
      }),
    ]);

    const summary = await pollResultSubmittedEvents({
      pool,
      rpc,
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 100n,
    });

    expect(summary.candidatesFound).toBe(1);
    expect(summary.newlyPending).toBe(1);
    expect(summary.transitioned).toBe(1);
    expect(summary.errors).toHaveLength(0);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("SUBMITTED");

    const { rows: pendingRows } = await pool.query(`SELECT id FROM pending_result_submissions`);
    expect(pendingRows).toHaveLength(0);
  });

  it("skips a scanned log whose taskId does not match any currently-ACCEPTED task", async () => {
    const scanner = buildFakeScanner([
      buildScannerEntry({
        taskId: ("0x" + "9".repeat(64)) as `0x${string}`,
        transactionHash: ("0x" + "2".repeat(64)) as `0x${string}`,
        agent: agent.address as `0x${string}`,
      }),
    ]);
    const rpc = buildFakeRpc(null);

    const summary = await pollResultSubmittedEvents({
      pool,
      rpc,
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 100n,
    });

    expect(summary.candidatesFound).toBe(0);
    expect(summary.newlyPending).toBe(0);
    expect(summary.transitioned).toBe(0);
  });

  it("does not call the scanner at all when there are no currently-ACCEPTED tasks", async () => {
    const scanner = buildFakeScanner([]);
    const scanSpy = vi.spyOn(scanner, "scanResultSubmittedLogs");
    const rpc = buildFakeRpc(null);

    await pollResultSubmittedEvents({
      pool,
      rpc,
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 100n,
    });

    expect(scanSpy).not.toHaveBeenCalled();
  });

  it("collects a per-task error without aborting the scan for other tasks", async () => {
    const taskIdA = await insertAcceptedTask();
    const taskIdB = await insertAcceptedTask();
    const taskIdOnChainA = deriveOnChainTaskId(taskIdA);
    const taskIdOnChainB = deriveOnChainTaskId(taskIdB);
    const txHashA = ("0x" + "3".repeat(64)) as `0x${string}`;
    const txHashB = ("0x" + "4".repeat(64)) as `0x${string}`;

    // Task A is "poisoned" (the mocked `verifyResultSubmission` throws for
    // it specifically, see this file's header comment) — a genuine
    // unexpected exception, not a routine ok:false outcome. Task B uses
    // the REAL implementation with a valid receipt, so it must still
    // transition normally: one bad task must never block another.
    poisonTaskId = taskIdA;
    const rpc = buildFakeRpc({
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [
        buildResultSubmittedLog({
          taskIdOnChain: taskIdOnChainB,
          agent: agent.address as `0x${string}`,
        }),
      ],
    });
    const scanner = buildFakeScanner([
      buildScannerEntry({
        taskId: taskIdOnChainA,
        transactionHash: txHashA,
        agent: agent.address as `0x${string}`,
      }),
      buildScannerEntry({
        taskId: taskIdOnChainB,
        transactionHash: txHashB,
        agent: agent.address as `0x${string}`,
      }),
    ]);

    const summary = await pollResultSubmittedEvents({
      pool,
      rpc,
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 100n,
    });

    expect(summary.candidatesFound).toBe(2);
    expect(summary.newlyPending).toBe(2);
    expect(summary.transitioned).toBe(1);
    expect(summary.errors).toEqual([
      { taskId: taskIdA, message: "simulated unexpected failure for this one task" },
    ]);

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM tasks WHERE id = ANY($1)`,
      [[taskIdA, taskIdB]],
    );
    expect(rows.find((row) => row.id === taskIdA)?.status).toBe("ACCEPTED");
    expect(rows.find((row) => row.id === taskIdB)?.status).toBe("SUBMITTED");
  });

  it("does not transition when the receipt is not yet available (routine, not an error)", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "5".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc(null); // no receipt yet — unmined
    const scanner = buildFakeScanner([
      buildScannerEntry({
        taskId: taskIdOnChain,
        transactionHash: txHash,
        agent: agent.address as `0x${string}`,
      }),
    ]);

    const summary = await pollResultSubmittedEvents({
      pool,
      rpc,
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 100n,
    });

    expect(summary.candidatesFound).toBe(1);
    expect(summary.newlyPending).toBe(1);
    expect(summary.transitioned).toBe(0);
    expect(summary.errors).toHaveLength(0);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.status).toBe("ACCEPTED");

    // The pending row is left in place for a later tick to retry — a
    // routine not-yet-mined receipt must never lose track of the event.
    const { rows: pendingRows } = await pool.query(`SELECT id FROM pending_result_submissions`);
    expect(pendingRows).toHaveLength(1);
  });

  // Human N4 follow-up (T-905, round B, P2-2, pure human review — round
  // cap already exhausted, no Codex call): this poller always re-scans its
  // FULL block range every tick (no cursor, N4 round 2 P1), so the SAME
  // log is rediscovered on every subsequent tick after the one that first
  // inserted it. `newlyPending` must count only the genuinely NEW row, not
  // every rediscovery — a naive "insert always increments" implementation
  // would report a fresh discovery on every tick forever, even though
  // `ON CONFLICT ... DO NOTHING` correctly keeps the DATABASE idempotent.
  it("re-scanning the same already-pending log on a later tick reports newlyPending: 0 (idempotent counting, not just idempotent storage)", async () => {
    const taskId = await insertAcceptedTask();
    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "6".repeat(64)) as `0x${string}`;
    const rpc = buildFakeRpc(null); // unmined both ticks — isolates discovery-counting from promotion
    const scanner = buildFakeScanner([
      buildScannerEntry({
        taskId: taskIdOnChain,
        transactionHash: txHash,
        agent: agent.address as `0x${string}`,
      }),
    ]);

    const tick1 = await pollResultSubmittedEvents({
      pool,
      rpc,
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 100n,
    });
    expect(tick1.newlyPending).toBe(1);

    const tick2 = await pollResultSubmittedEvents({
      pool,
      rpc,
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 100n,
    });
    expect(tick2.candidatesFound).toBe(1); // still a candidate — the log is still there
    expect(tick2.newlyPending).toBe(0); // but NOT newly pending — already inserted by tick 1

    const { rows: pendingRows } = await pool.query(
      `SELECT id FROM pending_result_submissions WHERE task_id = $1`,
      [taskId],
    );
    expect(pendingRows).toHaveLength(1); // still exactly one row, not two
  });
});
