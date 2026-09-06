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
import type {
  ResultSubmittedLogEntry,
  ResultSubmittedLogScanner,
} from "../chain/result-submitted-log-scanner.js";
import type { RawEventLog } from "@agent-market/domain";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import { pollResultSubmittedEvents } from "./result-submission-poller.js";

/**
 * See db/migrate.integration.test.ts's header comment: skipped unless a
 * human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
 * TEST_DATABASE_URL.
 *
 * T-905, human review round B (pure human finding, no Codex call — round
 * cap already exhausted): round A's reorg-rollback design operated on
 * `chain_events`, where every row is, by construction, ALREADY final by
 * the time it exists (`verifyResultSubmission` only ever writes one after
 * its own confirmations check already passed) — so "roll back an
 * unconfirmed chain_events projection" could never have anything to act
 * on, and round A's own end-to-end test only "passed" by mutating
 * `FUNDING_REQUIRED_CONFIRMATIONS` mid-test (1 -> 3) AFTER the projection
 * already existed, a change that cannot happen at runtime.
 *
 * This suite replaces that entirely. It uses a SINGLE, FIXED
 * `FUNDING_REQUIRED_CONFIRMATIONS = 3` for the whole file (set once in
 * `beforeAll`, never mutated mid-test) and exercises the real "pending
 * event/projection" state (`pending_result_submissions`, Option A of the
 * two options compared in the evidence packet) where "not yet confirmed"
 * is a genuinely reachable, naturally-occurring state — unlike the old
 * design.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, " +
  "tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, schema_migrations CASCADE";

const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";
const TASK_BUDGET = "1000";
const SUBMITTED_AT = 1_800_000_000n;
const REVIEW_DEADLINE = SUBMITTED_AT + 259_200n;
const FIXED_REQUIRED_CONFIRMATIONS = "3";

const STALE_BLOCK_HASH = "0x" + "b".repeat(64);
const NEW_CANONICAL_BLOCK_HASH = "0x" + "c".repeat(64);

function buildResultSubmittedReceiptLog(params: {
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

function buildScannerEntry(params: {
  taskId: `0x${string}`;
  transactionHash: `0x${string}`;
  agent: `0x${string}`;
  blockNumber: bigint;
  blockHash: string;
}): ResultSubmittedLogEntry {
  return {
    taskId: params.taskId,
    transactionHash: params.transactionHash,
    logIndex: 0,
    blockHash: params.blockHash as `0x${string}`,
    blockNumber: params.blockNumber,
    agent: params.agent,
  };
}

/**
 * A fake `ChainRpcClient` whose `getBlockNumber`/`getBlock`/
 * `getTransactionReceipt` answers are configured PER TICK via mutable
 * fields the test reassigns between `pollResultSubmittedEvents` calls —
 * models a real chain's state actually changing over time between polls,
 * without ever touching `FUNDING_REQUIRED_CONFIRMATIONS`.
 */
function buildFakeRpc(state: {
  currentBlockNumber: bigint;
  canonicalHashAtHeight: Map<bigint, string>;
  receiptsByTxHash: Map<string, TransactionReceiptResult>;
}): ChainRpcClient {
  return {
    async getTransactionReceipt(hash) {
      return state.receiptsByTxHash.get(hash.toLowerCase()) ?? null;
    },
    async getBlockNumber() {
      return state.currentBlockNumber;
    },
    async getBlock(params) {
      const hash = state.canonicalHashAtHeight.get(params.blockNumber);
      if (!hash) return null;
      const block: BlockResult = { hash, number: params.blockNumber };
      return block;
    },
    async getChainId() {
      return Number(TEST_CHAIN_ID);
    },
    async getTransaction() {
      throw new Error("not used by this poller path");
    },
    async readStakeRateBps() {
      throw new Error("not used by this poller path");
    },
    async readAuthorizedSigner() {
      throw new Error("not used by this poller path");
    },
    async readHasRole() {
      throw new Error("not used by this poller path");
    },
  };
}

runIfOptedIn("pending_result_submissions reorg lifecycle (integration, T-905 round B)", () => {
  let pool: Pool;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    process.env.CHAIN_ID = TEST_CHAIN_ID;
    process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
    process.env.YD_TOKEN_ADDRESS = YD_TOKEN_ADDRESS;
    process.env.YD_FAUCET_ADDRESS = YD_FAUCET_ADDRESS;
    // Set ONCE for the whole suite and never mutated mid-test (the exact
    // thing round A's test got wrong) — every test below relies on this
    // same fixed threshold throughout its own multi-tick sequence.
    process.env.FUNDING_REQUIRED_CONFIRMATIONS = FIXED_REQUIRED_CONFIRMATIONS;

    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    delete process.env.FUNDING_REQUIRED_CONFIRMATIONS;
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
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

  async function taskStatus(taskId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    const status = rows[0]?.status;
    if (!status) throw new Error("taskStatus: task not found");
    return status;
  }

  async function pendingCount(taskId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT id FROM pending_result_submissions WHERE task_id = $1`,
      [taskId],
    );
    return rows.length;
  }

  it(
    "unconfirmed pending row survives an unchanged canonical block, is deleted on a genuine reorg " +
      "(task stays ACCEPTED throughout), and a later canonical log is rediscovered and eventually promoted",
    async () => {
      const taskId = await insertAcceptedTask();
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const staleTxHash = ("0x" + "1".repeat(64)) as `0x${string}`;

      // Tick 1: discover a log at block 100, currently only 1 confirmation
      // (required: 3) — inserted as pending, task untouched.
      const rpcState = {
        currentBlockNumber: 100n,
        canonicalHashAtHeight: new Map<bigint, string>([[100n, STALE_BLOCK_HASH]]),
        receiptsByTxHash: new Map<string, TransactionReceiptResult>(),
      };
      const scanner: ResultSubmittedLogScanner = {
        async scanResultSubmittedLogs() {
          return [
            buildScannerEntry({
              taskId: taskIdOnChain,
              transactionHash: staleTxHash,
              agent: agent.address as `0x${string}`,
              blockNumber: 100n,
              blockHash: STALE_BLOCK_HASH,
            }),
          ];
        },
      };

      const tick1 = await pollResultSubmittedEvents({
        pool,
        rpc: buildFakeRpc(rpcState),
        scanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 100n,
      });
      expect(tick1.newlyPending).toBe(1);
      expect(tick1.transitioned).toBe(0);
      expect(tick1.rolledBack).toBe(0);
      expect(await taskStatus(taskId)).toBe("ACCEPTED");
      expect(await pendingCount(taskId)).toBe(1);

      // Tick 2: still only 1 confirmation, canonical block at height 100
      // is UNCHANGED — the pending row must survive, no rollback.
      const tick2 = await pollResultSubmittedEvents({
        pool,
        rpc: buildFakeRpc(rpcState),
        scanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 100n,
      });
      expect(tick2.rolledBack).toBe(0);
      expect(await taskStatus(taskId)).toBe("ACCEPTED");
      expect(await pendingCount(taskId)).toBe(1);

      // Tick 3: a genuine reorg — the canonical hash at height 100 changes.
      // The scanner no longer reports the reorged-away transaction. The
      // pending row must be deleted; task remains ACCEPTED (it never left
      // it).
      rpcState.canonicalHashAtHeight.set(100n, NEW_CANONICAL_BLOCK_HASH);
      const reorgedAwayScanner: ResultSubmittedLogScanner = {
        async scanResultSubmittedLogs() {
          return [];
        },
      };
      const tick3 = await pollResultSubmittedEvents({
        pool,
        rpc: buildFakeRpc(rpcState),
        scanner: reorgedAwayScanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 100n,
      });
      expect(tick3.rolledBack).toBe(1);
      expect(await taskStatus(taskId)).toBe("ACCEPTED");
      expect(await pendingCount(taskId)).toBe(0);

      // Tick 4: the SAME automatic path rediscovers a new canonical log
      // (mined in the reorg's replacement chain) and, once it reaches the
      // required 3 confirmations, promotes the task for real via the
      // already-N4-reviewed `verifyResultSubmission`.
      const newTxHash = ("0x" + "2".repeat(64)) as `0x${string}`;
      rpcState.currentBlockNumber = 102n; // confirmations = 102-100+1 = 3
      rpcState.canonicalHashAtHeight.set(100n, NEW_CANONICAL_BLOCK_HASH);
      rpcState.receiptsByTxHash.set(newTxHash, {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: NEW_CANONICAL_BLOCK_HASH,
        logs: [
          buildResultSubmittedReceiptLog({ taskIdOnChain, agent: agent.address as `0x${string}` }),
        ],
      });
      const resyncScanner: ResultSubmittedLogScanner = {
        async scanResultSubmittedLogs() {
          return [
            buildScannerEntry({
              taskId: taskIdOnChain,
              transactionHash: newTxHash,
              agent: agent.address as `0x${string}`,
              blockNumber: 100n,
              blockHash: NEW_CANONICAL_BLOCK_HASH,
            }),
          ];
        },
      };
      const tick4 = await pollResultSubmittedEvents({
        pool,
        rpc: buildFakeRpc(rpcState),
        scanner: resyncScanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 102n,
      });
      expect(tick4.newlyPending).toBe(1);
      expect(tick4.transitioned).toBe(1);
      expect(await taskStatus(taskId)).toBe("SUBMITTED");
      expect(await pendingCount(taskId)).toBe(0);
    },
  );

  it(
    "a log discovered already past the required confirmations is still reorg-checked before promotion (canonical block matches, so it promotes), " +
      "and is never rolled back afterward even if the canonical hash at its height later changes",
    async () => {
      const taskId = await insertAcceptedTask();
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "3".repeat(64)) as `0x${string}`;

      const rpcState = {
        currentBlockNumber: 102n, // confirmations = 102-100+1 = 3, already >= required 3
        canonicalHashAtHeight: new Map<bigint, string>([[100n, STALE_BLOCK_HASH]]),
        receiptsByTxHash: new Map<string, TransactionReceiptResult>([
          [
            txHash,
            {
              status: "success",
              to: TASK_ESCROW_ADDRESS,
              blockNumber: 100n,
              blockHash: STALE_BLOCK_HASH,
              logs: [
                buildResultSubmittedReceiptLog({
                  taskIdOnChain,
                  agent: agent.address as `0x${string}`,
                }),
              ],
            },
          ],
        ]),
      };
      let getBlockCalls = 0;
      const rpc = buildFakeRpc(rpcState);
      const instrumentedRpc: ChainRpcClient = {
        ...rpc,
        async getBlock(params) {
          getBlockCalls += 1;
          return rpc.getBlock(params);
        },
      };
      const scanner: ResultSubmittedLogScanner = {
        async scanResultSubmittedLogs() {
          return [
            buildScannerEntry({
              taskId: taskIdOnChain,
              transactionHash: txHash,
              agent: agent.address as `0x${string}`,
              blockNumber: 100n,
              blockHash: STALE_BLOCK_HASH,
            }),
          ];
        },
      };

      const tick1 = await pollResultSubmittedEvents({
        pool,
        rpc: instrumentedRpc,
        scanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 102n,
      });
      expect(tick1.transitioned).toBe(1);
      expect(tick1.rolledBack).toBe(0);
      expect(await taskStatus(taskId)).toBe("SUBMITTED");
      expect(await pendingCount(taskId)).toBe(0);
      // TWO `getBlock` calls this tick: (1) `promotePendingResultSubmissions`'s
      // OWN `checkProjectionForReorg` — round B P2-1's fix: the canonical
      // check now runs UNCONDITIONALLY for every pending row, before the
      // confirmations branch, precisely so an already-past-threshold row
      // that got reorged away in the same tick it crosses the threshold is
      // still caught (see that function's own doc comment for the bug this
      // closes) — then (2) `verifyResultSubmissionTransaction`'s own
      // already-N4-reviewed canonical-block check (result-submission-tx-verifier.ts),
      // which every promotion goes through regardless of how it was
      // discovered.
      expect(getBlockCalls).toBe(2);

      // A later tick where the canonical hash at height 100 changes (what
      // WOULD be a reorg signal for a still-pending row) must have zero
      // effect — there is no pending row left to reconsider.
      rpcState.canonicalHashAtHeight.set(100n, NEW_CANONICAL_BLOCK_HASH);
      const emptyScanner: ResultSubmittedLogScanner = {
        async scanResultSubmittedLogs() {
          return [];
        },
      };
      const tick2 = await pollResultSubmittedEvents({
        pool,
        rpc: buildFakeRpc(rpcState),
        scanner: emptyScanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 102n,
      });
      expect(tick2.rolledBack).toBe(0);
      expect(await taskStatus(taskId)).toBe("SUBMITTED");
    },
  );

  it(
    "a pending row reorged away while still unconfirmed is deleted (not promoted) even once a LATER tick's block " +
      "height has crossed the confirmation threshold — round B P2-1's exact bug scenario",
    async () => {
      const taskId = await insertAcceptedTask();
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "6".repeat(64)) as `0x${string}`;
      const discoveredHash = "0x" + "d".repeat(64);

      // Tick 1: discovered at block 100, current block 100 -> confirmations
      // = 1, BELOW the required 3. Still canonical at this point (no reorg
      // yet) -> stays pending.
      const rpcState = {
        currentBlockNumber: 100n,
        canonicalHashAtHeight: new Map<bigint, string>([[100n, discoveredHash]]),
        receiptsByTxHash: new Map<string, TransactionReceiptResult>(),
      };
      const scanner: ResultSubmittedLogScanner = {
        async scanResultSubmittedLogs() {
          return [
            buildScannerEntry({
              taskId: taskIdOnChain,
              transactionHash: txHash,
              agent: agent.address as `0x${string}`,
              blockNumber: 100n,
              blockHash: discoveredHash,
            }),
          ];
        },
      };
      const tick1 = await pollResultSubmittedEvents({
        pool,
        rpc: buildFakeRpc(rpcState),
        scanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 100n,
      });
      expect(tick1.newlyPending).toBe(1);
      expect(tick1.rolledBack).toBe(0);
      expect(await pendingCount(taskId)).toBe(1);

      // Between tick 1 and tick 2: a reorg replaces block 100's canonical
      // hash, AND enough new blocks are mined that the pending row's own
      // height (100) now has 3+ confirmations against the new chain tip —
      // both happen before the next tick observes either. The scanner no
      // longer reports this (reorged-away) transaction.
      rpcState.currentBlockNumber = 103n; // confirmations = 103-100+1 = 4 >= required 3
      rpcState.canonicalHashAtHeight.set(100n, NEW_CANONICAL_BLOCK_HASH); // no longer discoveredHash
      const emptyScanner: ResultSubmittedLogScanner = {
        async scanResultSubmittedLogs() {
          return [];
        },
      };

      const tick2 = await pollResultSubmittedEvents({
        pool,
        rpc: buildFakeRpc(rpcState),
        scanner: emptyScanner,
        contractAddress: TASK_ESCROW_ADDRESS,
        chainId: Number(TEST_CHAIN_ID),
        fromBlock: 0n,
        toBlock: 103n,
      });

      // The bug this fixes: with the OLD ordering (confirmations checked
      // BEFORE the canonical check), tick 2 would see confirmations >=
      // required and call `verifyResultSubmission` directly — which would
      // fail safely (no matching receipt/log), but leave the stale pending
      // row in place to be retried, uselessly, forever. The FIXED ordering
      // catches the reorg FIRST, regardless of confirmations.
      expect(tick2.rolledBack).toBe(1);
      expect(tick2.transitioned).toBe(0);
      expect(await pendingCount(taskId)).toBe(0);
      expect(await taskStatus(taskId)).toBe("ACCEPTED");
    },
  );

  it("processes an unrelated task's rollback and another task's promotion independently in the same tick", async () => {
    const taskIdRolledBack = await insertAcceptedTask();
    const taskIdPromoted = await insertAcceptedTask();
    const onChainRolledBack = deriveOnChainTaskId(taskIdRolledBack);
    const onChainPromoted = deriveOnChainTaskId(taskIdPromoted);
    const staleTxHash = ("0x" + "4".repeat(64)) as `0x${string}`;
    const confirmedTxHash = ("0x" + "5".repeat(64)) as `0x${string}`;
    const discoveredHashForA = "0x" + "d".repeat(64);

    // currentBlockNumber = 102n, required = 3:
    //   task A (rolled back) discovered at block 101 -> confirmations =
    //     102-101+1 = 2, BELOW required -> still eligible for a reorg
    //     check this very tick.
    //   task B (promoted) discovered at block 100 -> confirmations =
    //     102-100+1 = 3, AT required -> promoted directly this tick.
    const rpcState = {
      currentBlockNumber: 102n,
      canonicalHashAtHeight: new Map<bigint, string>([
        [101n, NEW_CANONICAL_BLOCK_HASH], // task A's height — no longer matches discoveredHashForA
        [100n, STALE_BLOCK_HASH], // task B's height — unused (already-confirmed, never reorg-checked)
      ]),
      receiptsByTxHash: new Map<string, TransactionReceiptResult>([
        [
          confirmedTxHash,
          {
            status: "success",
            to: TASK_ESCROW_ADDRESS,
            blockNumber: 100n,
            blockHash: STALE_BLOCK_HASH,
            logs: [
              buildResultSubmittedReceiptLog({
                taskIdOnChain: onChainPromoted,
                agent: agent.address as `0x${string}`,
              }),
            ],
          },
        ],
      ]),
    };
    const scanner: ResultSubmittedLogScanner = {
      async scanResultSubmittedLogs() {
        return [
          buildScannerEntry({
            taskId: onChainRolledBack,
            transactionHash: staleTxHash,
            agent: agent.address as `0x${string}`,
            blockNumber: 101n,
            blockHash: discoveredHashForA,
          }),
          buildScannerEntry({
            taskId: onChainPromoted,
            transactionHash: confirmedTxHash,
            agent: agent.address as `0x${string}`,
            blockNumber: 100n,
            blockHash: STALE_BLOCK_HASH,
          }),
        ];
      },
    };

    const tick1 = await pollResultSubmittedEvents({
      pool,
      rpc: buildFakeRpc(rpcState),
      scanner,
      contractAddress: TASK_ESCROW_ADDRESS,
      chainId: Number(TEST_CHAIN_ID),
      fromBlock: 0n,
      toBlock: 102n,
    });
    expect(tick1.newlyPending).toBe(2);
    expect(tick1.transitioned).toBe(1);
    expect(tick1.rolledBack).toBe(1);

    expect(await taskStatus(taskIdPromoted)).toBe("SUBMITTED");
    expect(await pendingCount(taskIdPromoted)).toBe(0);

    expect(await taskStatus(taskIdRolledBack)).toBe("ACCEPTED");
    expect(await pendingCount(taskIdRolledBack)).toBe(0);
  });
});
