import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress } from "viem";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import type {
  BlockResult,
  ChainRpcClient,
  TransactionReceiptResult,
  TransactionResult,
} from "../chain/rpc.client.js";
import { TASK_ACCEPTED_EVENT_ABI } from "@agent-market/domain";
import { TASK_ESCROW_ACCEPT_TASK_ABI } from "../chain/task-escrow-accept-abi.js";
import type { RawEventLog } from "@agent-market/domain";
import { insertAcceptancePermit } from "../dispatch/repository.js";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import { verifyAcceptance } from "./service.js";
import { getTaskById } from "./repository.js";

// See funding.integration.test.ts's header comment (same pattern): skipped
// unless a human opts in with RUN_DB_INTEGRATION_TESTS=1 against a
// confirmed-safe TEST_DATABASE_URL. This suite is T-801's dedicated
// verification of `verifyAcceptance` (tasks/service.ts) — a real PostgreSQL
// pool, a fake `ChainRpcClient` standing in for a real chain node, and
// `verifyAcceptance` called directly (not via `app.inject`), exactly
// mirroring how funding.integration.test.ts exercises `verifyFunding`.
//
// T-806 (human N6 BLOCK fix, round after T-803/T-805): this suite is
// substantially rewritten. T-803 round 2's wallet-level permit dedup — the
// invariant the old "genuinely ambiguous" test below depended on — was
// rejected by the human reviewer; every recommended candidate now gets its
// own permit, and `verifyAcceptance` now resolves EXACTLY which permit (and
// therefore which Agent) an acceptance belongs to by decoding the actual
// on-chain transaction's calldata for its `nonce`, not by counting distinct
// `agent_id`s under a wallet. The fake `ChainRpcClient` here now also needs
// `getTransaction`/`readStakeRateBps` (T-806's two new `ChainRpcClient`
// methods) — every helper below builds real `acceptTask` calldata via viem
// so the nonce-decoding path is exercised against actual encoding, not a
// hand-rolled stand-in.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, " +
  "tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE";

const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";

// insertOpenTask below always creates a task with budget '1000'. A 600 bps
// (6%) rate — matching contracts/src/TaskEscrow.sol's real STAKE_RATE_BPS
// constant — makes the independently-computed expected stake 1000*600/10000
// = 60, exactly. Every happy-path test's event stake is this value unless a
// test is deliberately proving the mismatch case.
const TASK_BUDGET = "1000";
const STAKE_RATE_BPS = 600n;
const EXPECTED_STAKE = 60n;

function buildAcceptedLog(params: {
  taskIdOnChain: `0x${string}`;
  agent: `0x${string}`;
  stake?: bigint;
  address?: `0x${string}`;
}): RawEventLog {
  const stake = params.stake ?? EXPECTED_STAKE;
  const topics = encodeEventTopics({
    abi: TASK_ACCEPTED_EVENT_ABI,
    eventName: "TaskAccepted",
    args: { taskId: params.taskIdOnChain, agent: getAddress(params.agent) },
  }) as readonly string[];
  const data = encodeAbiParameters([{ name: "stake", type: "uint256" }], [stake]);
  return {
    address: params.address ?? (TASK_ESCROW_ADDRESS as `0x${string}`),
    topics,
    data,
    logIndex: 0,
  };
}

/** Real `acceptTask` calldata, built with the same ABI
 * `decodeAcceptTaskCalldata` (acceptance-tx-verifier.ts) decodes — this is
 * what `resolveAcceptingAgentId` (dispatch/repository.ts) ultimately reads
 * the `nonce` from, so every test that expects a specific permit to be
 * matched must build calldata carrying THAT permit's exact nonce. */
function buildAcceptTaskCalldata(params: {
  taskIdOnChain: `0x${string}`;
  agent: `0x${string}`;
  nonce: bigint;
}): `0x${string}` {
  return encodeFunctionData({
    abi: TASK_ESCROW_ACCEPT_TASK_ABI,
    functionName: "acceptTask",
    args: [
      {
        taskId: params.taskIdOnChain,
        agent: getAddress(params.agent),
        nonce: params.nonce,
        expiry: 9_999_999_999n,
        chainId: BigInt(TEST_CHAIN_ID),
        verifyingContract: getAddress(TASK_ESCROW_ADDRESS),
      },
      ("0x" + "cd".repeat(65)) as `0x${string}`,
    ],
  });
}

interface FakeRpcOptions {
  receipt?: TransactionReceiptResult | null;
  chainId?: number;
  currentBlockNumber?: bigint;
  canonicalBlock?: BlockResult | null;
  throwOnReceipt?: Error;
  transaction?: TransactionResult | null;
  stakeRateBps?: bigint;
}

function buildFakeRpc(options: FakeRpcOptions = {}): ChainRpcClient {
  const {
    receipt = null,
    chainId = Number(TEST_CHAIN_ID),
    currentBlockNumber = 100n,
    canonicalBlock = { hash: "0x" + "b".repeat(64), number: 100n },
    throwOnReceipt,
    transaction = null,
    stakeRateBps = STAKE_RATE_BPS,
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
      return transaction;
    },
    async readStakeRateBps() {
      return stakeRateBps;
    },
    // Feature 7 sync (T-709): unused by verifyAcceptance's own tx
    // verification path — its sole caller is verifySignerMatchesContract
    // (permit.service.ts), exercised separately.
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by verifyAcceptance");
    },
    async readHasRole() {
      throw new Error("readHasRole: not used by verifyAcceptance");
    },
  };
}

runIfOptedIn("verifyAcceptance (integration, T-801/T-806)", () => {
  let pool: Pool;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agentOwner = privateKeyToAccount(generatePrivateKey());

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
    await pool.query("DELETE FROM acceptance_permits");
    await pool.query("DELETE FROM task_state_history");
    await pool.query("DELETE FROM chain_events");
    await pool.query("DELETE FROM chain_transactions");
    await pool.query("DELETE FROM task_skills");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
  });

  async function insertOpenTask(): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', $3, $2, '2099-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [requester.address.toLowerCase(), YD_TOKEN_ADDRESS, TASK_BUDGET],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertOpenTask: no id returned");
    return id;
  }

  async function insertAgent(ownerAddress: string): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      ownerAddress.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [ownerAddress.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  /** Minimal direct `recommendation_runs` insert — this file tests
   * `verifyAcceptance`'s ACCEPT-side logic (consume/invalidate), not
   * round-gating, so the exact run a permit belongs to is irrelevant to
   * what's being asserted; this only exists to satisfy `acceptance_permits
   * .run_id`'s NOT NULL FK (Feature 7 sync, T-709). */
  async function insertRecommendationRunDirect(taskId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.1', 1, 'test-digest') RETURNING id`,
      [taskId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertRecommendationRunDirect: no id returned");
    return id;
  }

  /** Mirrors what `insertPermitsForRunIfAbsent`/`insertRecommendationRunWithPermits`
   * (dispatch/repository.ts) actually write for one candidate — an
   * OUTSTANDING permit row for this (task, agent), with an explicit
   * `acceptingAddress`/`nonce` (T-806: both are now load-bearing —
   * `resolveAcceptingAgentId` matches on the exact
   * `(task_id, accepting_address, nonce)` triple, not merely "this agent
   * has some row"). Each call creates its own fresh recommendation run
   * unless `runId` is passed explicitly — callers that want several permits
   * bound to the SAME round pass the same `runId` to each call. */
  async function insertOutstandingPermit(
    taskId: string,
    agentId: string,
    options: { acceptingAddress?: string; nonce?: string; runId?: string } = {},
  ): Promise<void> {
    const runId = options.runId ?? (await insertRecommendationRunDirect(taskId));
    await insertAcceptancePermit(pool, {
      taskId,
      runId,
      agentId,
      acceptingAddress: options.acceptingAddress ?? agentOwner.address,
      nonce: options.nonce ?? "1",
      expiry: Math.floor(Date.now() / 1000) + 3600,
      chainId: Number(TEST_CHAIN_ID),
      verifyingContract: TASK_ESCROW_ADDRESS,
      signature: "0x" + "ab".repeat(65),
    });
  }

  it("accepts a task end to end: OPEN -> ACCEPTED, accepted_agent_id/address/at set, chain_events recorded, and the exact consumed permit's status/consumed_tx_hash are set (T-806)", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "1".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 1n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const result = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    const updated = await getTaskById(pool, taskId);
    expect(updated?.status).toBe("ACCEPTED");

    const acceptedColumns = await pool.query<{
      accepted_agent_id: string;
      accepted_agent_address: string;
      accepted_at: Date | null;
    }>(`SELECT accepted_agent_id, accepted_agent_address, accepted_at FROM tasks WHERE id = $1`, [
      taskId,
    ]);
    expect(acceptedColumns.rows[0]?.accepted_agent_id).toBe(agentId);
    expect(acceptedColumns.rows[0]?.accepted_agent_address).toBe(agentOwner.address.toLowerCase());
    expect(acceptedColumns.rows[0]?.accepted_at).not.toBeNull();

    const chainEvents = await pool.query(`SELECT event_name FROM chain_events WHERE task_id = $1`, [
      taskId,
    ]);
    expect(chainEvents.rows).toHaveLength(1);
    expect(chainEvents.rows[0].event_name).toBe("TaskAccepted");

    const permits = await pool.query<{
      status: string;
      consumed_at: Date | null;
      consumed_tx_hash: string | null;
      nonce: string;
    }>(
      `SELECT status, consumed_at, consumed_tx_hash, nonce FROM acceptance_permits WHERE task_id = $1 AND agent_id = $2`,
      [taskId, agentId],
    );
    expect(permits.rows).toHaveLength(1);
    expect(permits.rows[0]?.status).toBe("CONSUMED");
    expect(permits.rows[0]?.consumed_at).not.toBeNull();
    expect(permits.rows[0]?.consumed_tx_hash).toBe(txHash);
  });

  // T-806, user's item #5 (Codex review, T-806 round 1, P1 fix): EVERY
  // outstanding permit for this task other than the exact (agentId, nonce)
  // row just consumed must become INVALIDATED — including the winning
  // agent's OWN other historical rows (e.g. a prior `/match` run that also
  // recommended this same Agent). `invalidateOtherOutstandingPermits` scopes
  // by `NOT (agent_id = $2 AND nonce = $3)`, not a bare `agent_id != $2`, so
  // no OUTSTANDING row for this task can ever survive an acceptance except
  // the one actually consumed.
  it("invalidates every other outstanding permit for this task, including the winning agent's OWN other historical round", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" }); // an earlier round for the winner
    await insertOutstandingPermit(taskId, agentId, { nonce: "2" }); // the one actually used

    const otherAgentOwner = privateKeyToAccount(generatePrivateKey());
    const otherAgentId = await insertAgent(otherAgentOwner.address);
    await insertOutstandingPermit(taskId, otherAgentId, {
      acceptingAddress: otherAgentOwner.address,
      nonce: "1",
    });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "2".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 2n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const result = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    const { rows } = await pool.query<{ agent_id: string; nonce: string; status: string }>(
      `SELECT agent_id, nonce, status FROM acceptance_permits WHERE task_id = $1 ORDER BY agent_id, nonce`,
      [taskId],
    );
    const winner = rows.find((r) => r.agent_id === agentId && r.nonce === "2");
    const winnersOtherRound = rows.find((r) => r.agent_id === agentId && r.nonce === "1");
    const otherCandidate = rows.find((r) => r.agent_id === otherAgentId);
    expect(winner?.status).toBe("CONSUMED");
    // Excluded only by exact (agentId, nonce) — the winner's OWN other
    // historical round is a different nonce, so it must be INVALIDATED too,
    // not left OUTSTANDING (Codex review, T-806 round 1, P1).
    expect(winnersOtherRound?.status).toBe("INVALIDATED");
    expect(otherCandidate?.status).toBe("INVALIDATED");
  });

  // T-806, user's item #2: same wallet owns two candidate Agents, each with
  // its own outstanding permit (no dedup) — the exact nonce decoded from
  // the transaction's own calldata must resolve to the RIGHT Agent, not an
  // arbitrary/ambiguous one.
  it("resolves to the exact Agent whose permit's nonce matches the transaction's calldata, when the same wallet owns two candidate Agents", async () => {
    const taskId = await insertOpenTask();
    const sharedWallet = privateKeyToAccount(generatePrivateKey());
    const agentA = await insertAgent(sharedWallet.address);
    const agentB = await insertAgent(sharedWallet.address);
    await insertOutstandingPermit(taskId, agentA, {
      acceptingAddress: sharedWallet.address,
      nonce: "11",
    });
    await insertOutstandingPermit(taskId, agentB, {
      acceptingAddress: sharedWallet.address,
      nonce: "22",
    });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "9".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: sharedWallet.address as `0x${string}` })],
    };
    // The transaction actually used agentB's permit (nonce 22).
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: sharedWallet.address as `0x${string}`,
          nonce: 22n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const result = await verifyAcceptance(pool, rpc, sharedWallet.address, taskId, txHash);
    expect(result).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    const { rows: taskRows } = await pool.query<{ accepted_agent_id: string }>(
      `SELECT accepted_agent_id FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(taskRows[0]?.accepted_agent_id).toBe(agentB);

    const { rows: permitRows } = await pool.query<{ agent_id: string; status: string }>(
      `SELECT agent_id, status FROM acceptance_permits WHERE task_id = $1 ORDER BY agent_id`,
      [taskId],
    );
    const forB = permitRows.find((r) => r.agent_id === agentB);
    const forA = permitRows.find((r) => r.agent_id === agentA);
    expect(forB?.status).toBe("CONSUMED");
    expect(forA?.status).toBe("INVALIDATED");
  });

  it("is idempotent: resubmitting the same txHash after ACCEPTED does not insert a second chain_events/chain_transactions row", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "2".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 1n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const first = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, txHash);
    expect(first).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    const beforeEvents = await pool.query(
      `SELECT count(*)::int AS count FROM chain_events WHERE task_id = $1`,
      [taskId],
    );
    const beforeTx = await pool.query(
      `SELECT count(*)::int AS count FROM chain_transactions WHERE task_id = $1`,
      [taskId],
    );

    const second = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, txHash);
    expect(second).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    const afterEvents = await pool.query(
      `SELECT count(*)::int AS count FROM chain_events WHERE task_id = $1`,
      [taskId],
    );
    const afterTx = await pool.query(
      `SELECT count(*)::int AS count FROM chain_transactions WHERE task_id = $1`,
      [taskId],
    );
    expect(afterEvents.rows[0].count).toBe(beforeEvents.rows[0].count);
    expect(afterTx.rows[0].count).toBe(beforeTx.rows[0].count);
  });

  // Regression for Codex round 2 P2: the idempotent-replay success path
  // must be scoped to the actual accepting wallet — a stranger resubmitting
  // the same (publicly visible, already-mined) acceptance txHash must NOT
  // get back the same success response the real acceptor would.
  it("returns conflict (not a replay success) when a STRANGER resubmits the already-mined acceptance txHash", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "a".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 1n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const first = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, txHash);
    expect(first).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    const stranger = privateKeyToAccount(generatePrivateKey());
    const replayedByStranger = await verifyAcceptance(pool, rpc, stranger.address, taskId, txHash);
    expect(replayedByStranger).toEqual({
      ok: false,
      reason: "conflict",
      currentStatus: "ACCEPTED",
    });
  });

  it("returns conflict when the task is already ACCEPTED and a DIFFERENT txHash is submitted", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const firstTxHash = ("0x" + "3".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 1n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });
    const first = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, firstTxHash);
    expect(first).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    const secondTxHash = ("0x" + "4".repeat(64)) as `0x${string}`;
    const result = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, secondTxHash);
    expect(result).toEqual({ ok: false, reason: "conflict", currentStatus: "ACCEPTED" });
  });

  // Regression for Codex round 1 P2: `findExistingAcceptanceForTask`'s
  // replay check must be scoped to `purpose = 'ACCEPTANCE'` — without it, a
  // task's own recorded FUNDING transaction hash (same taskId, different
  // purpose) would satisfy the lookup and be treated as a valid acceptance
  // replay.
  it("does NOT treat the task's own FUNDING txHash as a valid acceptance replay once ACCEPTED", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const fundingTxHash = ("0x" + "6".repeat(64)) as `0x${string}`;
    await pool.query(
      `INSERT INTO chain_transactions (tx_hash, chain_id, task_id, purpose, status, confirmations)
       VALUES ($1, $2, $3, 'FUNDING', 'confirmed', 5)`,
      [fundingTxHash, Number(TEST_CHAIN_ID), taskId],
    );

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const acceptanceTxHash = ("0x" + "7".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 1n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });
    const accepted = await verifyAcceptance(
      pool,
      rpc,
      agentOwner.address,
      taskId,
      acceptanceTxHash,
    );
    expect(accepted).toEqual({ ok: true, status: "ACCEPTED", confirmations: 1 });

    // Resubmitting the task's own FUNDING txHash must NOT be accepted as an
    // "already accepted with this txHash" replay — it's a conflict, exactly
    // like any other unrelated txHash would be.
    const replayedWithFundingHash = await verifyAcceptance(
      pool,
      rpc,
      agentOwner.address,
      taskId,
      fundingTxHash,
    );
    expect(replayedWithFundingHash).toEqual({
      ok: false,
      reason: "conflict",
      currentStatus: "ACCEPTED",
    });
  });

  it("returns conflict for a task that is neither OPEN nor ACCEPTED (e.g. DRAFT)", async () => {
    const taskId = await insertOpenTask();
    await pool.query(`UPDATE tasks SET status = 'DRAFT' WHERE id = $1`, [taskId]);

    const rpc = buildFakeRpc();
    const result = await verifyAcceptance(
      pool,
      rpc,
      agentOwner.address,
      taskId,
      ("0x" + "5".repeat(64)) as `0x${string}`,
    );
    expect(result).toEqual({ ok: false, reason: "conflict", currentStatus: "DRAFT" });
  });

  it("returns not_found for a nonexistent task", async () => {
    const rpc = buildFakeRpc();
    const result = await verifyAcceptance(
      pool,
      rpc,
      agentOwner.address,
      "00000000-0000-4000-8000-000000000000",
      ("0x" + "6".repeat(64)) as `0x${string}`,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns chain_error/FUNDING_EVENT_MISMATCH and leaves the task OPEN when the decoded event's agent does not match the submitting session address", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "7".repeat(64)) as `0x${string}`;
    // Event decodes fine, but for a DIFFERENT agent than the one submitting
    // this verification request.
    const stranger = privateKeyToAccount(generatePrivateKey());
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({ receipt, currentBlockNumber: 100n });

    const result = await verifyAcceptance(pool, rpc, stranger.address, taskId, txHash);
    expect(result).toMatchObject({
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
    });

    const updated = await getTaskById(pool, taskId);
    expect(updated?.status).toBe("OPEN");
  });

  it("returns chain_error/FUNDING_EVENT_MISMATCH when the accepting wallet has no registered Agent/permit at all (resolveAcceptingAgentId finds nothing)", async () => {
    const taskId = await insertOpenTask();
    // Deliberately no `agents`/`acceptance_permits` row registered for this
    // wallet — the on-chain event still decodes and matches (this wallet
    // DID submit and sign for itself), but resolveAcceptingAgentId has no
    // outstanding permit row to resolve to, which acceptTask's own
    // permit-signature check should make unreachable in practice — this
    // test exercises that defensive branch.
    const noAgentAccount = privateKeyToAccount(generatePrivateKey());

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "8".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: noAgentAccount.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: noAgentAccount.address as `0x${string}`,
          nonce: 1n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const result = await verifyAcceptance(pool, rpc, noAgentAccount.address, taskId, txHash);
    expect(result).toMatchObject({
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
    });

    const updated = await getTaskById(pool, taskId);
    expect(updated?.status).toBe("OPEN");
  });

  // T-806: a nonce that doesn't match ANY outstanding permit row (even
  // though a permit DOES exist for this wallet under a different nonce)
  // must also fail closed — proving `resolveAcceptingAgentId`'s exact-match
  // scoping, not a "does this wallet have anything at all" fallback.
  it("returns chain_error/FUNDING_EVENT_MISMATCH when the decoded nonce doesn't match any outstanding permit for this wallet", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "d".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [buildAcceptedLog({ taskIdOnChain, agent: agentOwner.address as `0x${string}` })],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        // Nonce 999 was never issued — only nonce "1" was.
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 999n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const result = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, txHash);
    expect(result).toMatchObject({
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
    });

    const updated = await getTaskById(pool, taskId);
    expect(updated?.status).toBe("OPEN");
    const { rows } = await pool.query<{ accepted_agent_id: string | null }>(
      `SELECT accepted_agent_id FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows[0]?.accepted_agent_id ?? null).toBeNull();
  });

  // T-806, user's item #6: independent stake verification — a mismatched
  // stake must fail closed (chain_error), leaving the task OPEN and no
  // permit consumed.
  it("returns chain_error/FUNDING_EVENT_MISMATCH and leaves the task OPEN when the event's stake does not match budget * STAKE_RATE_BPS / 10000", async () => {
    const taskId = await insertOpenTask();
    const agentId = await insertAgent(agentOwner.address);
    await insertOutstandingPermit(taskId, agentId, { nonce: "1" });

    const taskIdOnChain = deriveOnChainTaskId(taskId);
    const txHash = ("0x" + "e".repeat(64)) as `0x${string}`;
    const receipt: TransactionReceiptResult = {
      status: "success",
      to: TASK_ESCROW_ADDRESS,
      blockNumber: 100n,
      blockHash: "0x" + "b".repeat(64),
      logs: [
        buildAcceptedLog({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          stake: EXPECTED_STAKE + 1n, // wrong by 1
        }),
      ],
    };
    const rpc = buildFakeRpc({
      receipt,
      currentBlockNumber: 100n,
      transaction: {
        input: buildAcceptTaskCalldata({
          taskIdOnChain,
          agent: agentOwner.address as `0x${string}`,
          nonce: 1n,
        }),
        from: "0x3333333333333333333333333333333333333c",
      },
    });

    const result = await verifyAcceptance(pool, rpc, agentOwner.address, taskId, txHash);
    expect(result).toMatchObject({
      ok: false,
      reason: "chain_error",
      code: "FUNDING_EVENT_MISMATCH",
    });

    const updated = await getTaskById(pool, taskId);
    expect(updated?.status).toBe("OPEN");
    const permits = await pool.query<{ status: string }>(
      `SELECT status FROM acceptance_permits WHERE task_id = $1 AND agent_id = $2`,
      [taskId, agentId],
    );
    expect(permits.rows[0]?.status).toBe("OUTSTANDING");
  });
});
