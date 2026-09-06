import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import type { BlockResult, ChainRpcClient, TransactionReceiptResult } from "../chain/rpc.client.js";
import { TASK_FUNDED_EVENT_ABI, type RawEventLog } from "@agent-market/domain";
import { deriveOnChainTaskId } from "./onchain-task-id.js";
import { createFundingIntent, verifyFunding } from "./service.js";
import { findChainTransactionOwner, getTaskById, insertChainTransaction } from "./repository.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite is T-604's dedicated verification of
// `POST /tasks/:taskId/funding-intent` and
// `POST /tasks/:taskId/funding-verifications` (DRAFT → AWAITING_FUNDING →
// OPEN), reusing T-603's already-reviewed `tx-verifier.ts` rather than
// re-testing its rules — the fake `ChainRpcClient` here only stands in for
// a real chain node, it never re-implements what "confirmed"/"matches the
// draft" means.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, " +
  "tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

// A trusted, well-formed (but not really deployed) TaskEscrow address —
// deliberately non-zero, since packages/domain's resolveChainConfig throws
// on the zero-address .env.example placeholder (T-604 capsule's explicit
// note). Test-only; never a real deployment.
const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";

const VALID_DRAFT_PAYLOAD = {
  category: "writing",
  skillTags: ["copywriting"],
  title: "Write a landing page",
  description: "Need 500 words of marketing copy.",
  budget: "125500000000000000000",
  deliveryDeadline: "2099-01-01T00:00:00.000Z",
  expertType: "CONTENT_GENERATION",
};

function buildFundedLog(params: {
  taskIdOnChain: `0x${string}`;
  requester: `0x${string}`;
  token: `0x${string}`;
  budget: bigint;
  deliveryDeadlineSeconds: bigint;
  address?: `0x${string}`;
}): RawEventLog {
  const topics = encodeEventTopics({
    abi: TASK_FUNDED_EVENT_ABI,
    eventName: "TaskFunded",
    args: { taskId: params.taskIdOnChain, requester: getAddress(params.requester) },
  }) as readonly string[];
  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "deliveryDeadline", type: "uint64" },
    ],
    [getAddress(params.token), params.budget, params.deliveryDeadlineSeconds],
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
    // T-806: unused by funding verification — see tx-verifier.test.ts's
    // identical stub for why.
    async getTransaction() {
      throw new Error("getTransaction: not used by funding verification");
    },
    async readStakeRateBps() {
      throw new Error("readStakeRateBps: not used by funding verification");
    },
    // Feature 7 sync (T-709): unused by funding verification — see above.
    async readAuthorizedSigner() {
      throw new Error("readAuthorizedSigner: not used by funding verification");
    },
    async readHasRole() {
      throw new Error("readHasRole: not used by funding verification");
    },
  };
}

runIfOptedIn(
  "POST /tasks/:taskId/funding-intent, verifyFunding (integration, F-604/F-605/F-606/AC-602..605)",
  () => {
    let pool: Pool;
    let app: ReturnType<typeof buildApp>;
    const requester = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());

    beforeAll(async () => {
      process.env.CHAIN_ID = TEST_CHAIN_ID;
      process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
      process.env.YD_TOKEN_ADDRESS = YD_TOKEN_ADDRESS;
      process.env.YD_FAUCET_ADDRESS = YD_FAUCET_ADDRESS;
      delete process.env.FUNDING_REQUIRED_CONFIRMATIONS; // default: 1

      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
    });

    afterEach(async () => {
      await pool.query("DELETE FROM task_state_history");
      await pool.query("DELETE FROM chain_events");
      await pool.query("DELETE FROM chain_transactions");
      await pool.query("DELETE FROM task_skills");
      await pool.query("DELETE FROM tasks");
      await pool.query("DELETE FROM sessions");
      await pool.query("DELETE FROM auth_nonces");
      await pool.query("DELETE FROM users");
    });

    async function login(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
      const nonceResponse = await app.inject({
        method: "POST",
        url: "/auth/nonce",
        payload: { address: account.address },
      });
      const { nonce, issuedAt, expiresAt } = nonceResponse.json();
      const message = buildSignInMessage({
        domain: "localhost",
        address: account.address,
        nonce,
        issuedAt: new Date(issuedAt),
        expiresAt: new Date(expiresAt),
      });
      const signature = await account.signMessage({ message });
      const verifyResponse = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: { address: account.address, signature, nonce },
      });
      const setCookie = verifyResponse.headers["set-cookie"];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const match = /session_token=([^;]+)/.exec(String(header));
      if (!match?.[1]) throw new Error("no session_token cookie in verify response");
      return match[1];
    }

    async function createDraft(token: string): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: token },
        payload: VALID_DRAFT_PAYLOAD,
      });
      expect(response.statusCode).toBe(201);
      return response.json().taskId as string;
    }

    async function postFundingIntent(token: string, taskId: string) {
      return app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-intent`,
        cookies: { session_token: token },
      });
    }

    /**
     * Polls `pg_stat_activity` for a backend genuinely blocked waiting on a
     * `FOR UPDATE` lock — a real database-state fact, not a guessed
     * duration. Used to synchronize a test with the exact moment
     * `transitionTaskStatus`'s row lock attempt is actually blocked on
     * another session's held lock, per human review (T-605 round 3): "不得
     * 使用固定 setTimeout 猜测锁是否已到位，应使用明确测试同步点或查询数据库锁/事务状态".
     * Polls on a short interval up to `timeoutMs`; throws (failing the test
     * with a clear message) rather than silently proceeding if the expected
     * blocked waiter never appears.
     */
    async function waitForBlockedRowLockWaiter(
      deadlinePool: Pool,
      timeoutMs = 5000,
    ): Promise<void> {
      const startedAt = Date.now();
      for (;;) {
        const { rows } = await deadlinePool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_stat_activity
            WHERE state = 'active'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%FOR UPDATE%'
              AND query ILIKE '%tasks%'`,
        );
        if (Number(rows[0]?.count ?? "0") > 0) {
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(
            `waitForBlockedRowLockWaiter: no backend observed blocked on a tasks FOR UPDATE lock within ${timeoutMs}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    it("returns the funding intent and transitions DRAFT -> AWAITING_FUNDING with a history row (F-604)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      const response = await postFundingIntent(token, taskId);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.contractAddress).toBe(TASK_ESCROW_ADDRESS.toLowerCase());
      expect(body.token).toBe(YD_TOKEN_ADDRESS.toLowerCase());
      expect(body.budget).toBe(VALID_DRAFT_PAYLOAD.budget);
      expect(body.taskIdOnChain).toBe(deriveOnChainTaskId(taskId));

      const { rows } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
      expect(rows[0].status).toBe("AWAITING_FUNDING");

      const history = await pool.query(
        `SELECT from_status, to_status FROM task_state_history WHERE task_id = $1`,
        [taskId],
      );
      expect(history.rows).toContainEqual({ from_status: "DRAFT", to_status: "AWAITING_FUNDING" });
    });

    it("is idempotent: calling funding-intent again on an AWAITING_FUNDING task returns the same taskIdOnChain and creates no second task (AC-605)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      const first = await postFundingIntent(token, taskId);
      const second = await postFundingIntent(token, taskId);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json().taskIdOnChain).toBe(second.json().taskIdOnChain);

      const { rows } = await pool.query(
        `SELECT count(*)::int AS count FROM tasks WHERE requester_address = $1`,
        [requester.address.toLowerCase()],
      );
      expect(rows[0].count).toBe(1);

      const history = await pool.query(
        `SELECT count(*)::int AS count FROM task_state_history WHERE task_id = $1`,
        [taskId],
      );
      // Only the first call actually transitions the row; the second is a
      // pure read-back, so exactly one history row exists.
      expect(history.rows[0].count).toBe(1);
    });

    it("returns 409 TASK_STATE_CONFLICT for a task that is already OPEN", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [taskId]);

      const response = await postFundingIntent(token, taskId);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("TASK_STATE_CONFLICT");
    });

    it("rejects funding-intent with 400 and leaves the task DRAFT when the deadline has passed since draft creation (Codex round 2 P1)", async () => {
      // createDraftSchema's DELIVERY_DEADLINE_SCHEMA only rejects a deadline
      // that's already in the past AT CREATION time — it cannot prevent a
      // valid deadline from later passing while the draft sits unfunded.
      // Backdating directly in the DB (rather than waiting out a real
      // deadline) is what makes this test fast and deterministic.
      const token = await login(requester);
      const taskId = await createDraft(token);
      await pool.query(
        `UPDATE tasks SET delivery_deadline = now() - interval '1 hour' WHERE id = $1`,
        [taskId],
      );

      const response = await postFundingIntent(token, taskId);
      expect(response.statusCode).toBe(400);

      // Must NOT have transitioned — that's the entire point of the fix:
      // once AWAITING_FUNDING, this task could never have its deadline
      // edited back to something valid (only DRAFT tasks are editable).
      const { rows } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
      expect(rows[0].status).toBe("DRAFT");
    });

    it("controlled-concurrency: a deadline that expires WHILE createFundingIntent is blocked waiting for the row lock is still caught (closes the TOCTOU gap, human review T-605 round 3)", async () => {
      // This is the scenario a plain "check deadline, then call
      // transitionTaskStatus" would miss: the check passes (deadline still
      // valid), then the call blocks waiting for the row lock, and only
      // AFTER the lock is finally granted has the deadline actually passed
      // — by which point a pre-lock check has no opportunity to run again.
      // The fix (repository.ts's `precondition` hook) re-reads the row
      // INSIDE the lock, so it must catch this even though the deadline
      // was still valid at the moment `createFundingIntent` was called.
      const token = await login(requester);
      const taskId = await createDraft(token);

      const lockHolder = await pool.connect();
      try {
        await lockHolder.query("BEGIN");
        // Holds the row lock — deadline is still valid at this point.
        await lockHolder.query(`SELECT status FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);

        // Starts on a different pool connection; its own `SELECT ... FOR
        // UPDATE` (inside transitionTaskStatus) will block on lockHolder's
        // still-open transaction.
        const intentPromise = createFundingIntent(pool, requester.address, taskId);

        // Waits for a real, observed fact (a backend genuinely blocked on
        // the lock) rather than guessing how long that takes.
        await waitForBlockedRowLockWaiter(pool);

        // NOW expire the deadline — after createFundingIntent has already
        // been called and is already blocked, proving the precondition
        // check happening after lock acquisition (not before the call) is
        // what catches this.
        await lockHolder.query(
          `UPDATE tasks SET delivery_deadline = now() - interval '1 hour' WHERE id = $1`,
          [taskId],
        );
        await lockHolder.query("COMMIT");

        const result = await intentPromise;
        expect(result).toEqual({ ok: false, reason: "expired_deadline" });
      } finally {
        lockHolder.release();
      }

      const { rows } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
      expect(rows[0].status).toBe("DRAFT");

      const history = await pool.query(
        `SELECT count(*)::int AS count FROM task_state_history WHERE task_id = $1`,
        [taskId],
      );
      expect(history.rows[0].count).toBe(0);
    });

    it("returns 403 for a caller that does not own the task", async () => {
      const requesterToken = await login(requester);
      const strangerToken = await login(stranger);
      const taskId = await createDraft(requesterToken);

      const response = await postFundingIntent(strangerToken, taskId);
      expect(response.statusCode).toBe(403);
    });

    it("funds a task end to end: AWAITING_FUNDING -> OPEN, funding_tx_hash + chain_transactions + chain_events + history all recorded (AC-602)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "1".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));

      const receipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget),
            deliveryDeadlineSeconds,
          }),
        ],
      };
      const rpc = buildFakeRpc({ receipt, currentBlockNumber: 100n });

      const result = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
      expect(result).toEqual({ ok: true, status: "OPEN", confirmations: 1 });

      const updated = await getTaskById(pool, taskId);
      expect(updated?.status).toBe("OPEN");
      expect(updated?.fundingTxHash).toBe(txHash);

      const chainTx = await pool.query(
        `SELECT purpose, status, confirmations FROM chain_transactions WHERE task_id = $1`,
        [taskId],
      );
      expect(chainTx.rows).toHaveLength(1);
      expect(chainTx.rows[0]).toMatchObject({ purpose: "FUNDING", status: "confirmed" });

      const chainEvents = await pool.query(
        `SELECT event_name FROM chain_events WHERE task_id = $1`,
        [taskId],
      );
      expect(chainEvents.rows).toHaveLength(1);
      expect(chainEvents.rows[0].event_name).toBe("TaskFunded");

      const history = await pool.query(
        `SELECT from_status, to_status FROM task_state_history WHERE task_id = $1 ORDER BY occurred_at`,
        [taskId],
      );
      expect(history.rows).toContainEqual({
        from_status: "AWAITING_FUNDING",
        to_status: "OPEN",
      });
    });

    it("rejects an event that does not match the draft (wrong budget) with FUNDING_EVENT_MISMATCH and does not change task status (AC-603)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "2".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));

      const receipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget) + 1n, // wrong budget
            deliveryDeadlineSeconds,
          }),
        ],
      };
      const rpc = buildFakeRpc({ receipt, currentBlockNumber: 100n });

      const result = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
      expect(result).toMatchObject({
        ok: false,
        reason: "chain_error",
        code: "FUNDING_EVENT_MISMATCH",
      });

      const updated = await getTaskById(pool, taskId);
      expect(updated?.status).toBe("AWAITING_FUNDING");
      expect(updated?.fundingTxHash).toBeNull();
    });

    it("keeps the task AWAITING_FUNDING (not failed) when the RPC reports the transaction as not yet confirmed (AC-604)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "3".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));

      const receipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget),
            deliveryDeadlineSeconds,
          }),
        ],
      };
      // currentBlockNumber === receipt.blockNumber - 1 would be impossible
      // (receipt couldn't exist yet), so instead simulate "not enough
      // confirmations" by requiring more than the default of 1: set
      // currentBlockNumber equal to the receipt's own block (0
      // confirmations short of nothing — use a required-confirmations env
      // override instead for a realistic not-confirmed scenario).
      process.env.FUNDING_REQUIRED_CONFIRMATIONS = "5";
      const rpc = buildFakeRpc({ receipt, currentBlockNumber: 100n }); // only 1 confirmation

      try {
        const result = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
        expect(result).toMatchObject({
          ok: false,
          reason: "chain_error",
          code: "TRANSACTION_NOT_CONFIRMED",
        });

        const updated = await getTaskById(pool, taskId);
        expect(updated?.status).toBe("AWAITING_FUNDING");
        expect(updated?.fundingTxHash).toBeNull();
      } finally {
        delete process.env.FUNDING_REQUIRED_CONFIRMATIONS;
      }
    });

    it("keeps the task AWAITING_FUNDING when the RPC is temporarily unavailable (AC-604)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const txHash = ("0x" + "4".repeat(64)) as `0x${string}`;
      const rpc = buildFakeRpc({ throwOnReceipt: new Error("ECONNRESET") });

      const result = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
      expect(result).toMatchObject({
        ok: false,
        reason: "chain_error",
        code: "RPC_TEMPORARILY_UNAVAILABLE",
      });

      const updated = await getTaskById(pool, taskId);
      expect(updated?.status).toBe("AWAITING_FUNDING");
    });

    it("returns RPC_TEMPORARILY_UNAVAILABLE (not a 500) when the second getTransactionReceipt call (for logIndex) fails, leaving the task AWAITING_FUNDING (Codex round 1 P1)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "9".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));

      const receipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget),
            deliveryDeadlineSeconds,
          }),
        ],
      };

      // First call (inside verifyFundingTransaction) succeeds; second call
      // (verifyFunding's own re-fetch for logIndex) throws — simulating an
      // RPC that drops the connection between the two calls.
      let callCount = 0;
      const rpc: ChainRpcClient = {
        async getTransactionReceipt() {
          callCount += 1;
          if (callCount === 1) return receipt;
          throw new Error("ECONNRESET on second receipt fetch");
        },
        async getBlockNumber() {
          return 100n;
        },
        async getBlock() {
          return { hash: "0x" + "b".repeat(64), number: 100n };
        },
        async getChainId() {
          return Number(TEST_CHAIN_ID);
        },
        async getTransaction() {
          throw new Error("getTransaction: not used by funding verification");
        },
        async readStakeRateBps() {
          throw new Error("readStakeRateBps: not used by funding verification");
        },
        // Feature 7 sync (T-709): unused by funding verification — see above.
        async readAuthorizedSigner() {
          throw new Error("readAuthorizedSigner: not used by funding verification");
        },
        async readHasRole() {
          throw new Error("readHasRole: not used by funding verification");
        },
      };

      const result = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
      expect(result).toMatchObject({
        ok: false,
        reason: "chain_error",
        code: "RPC_TEMPORARILY_UNAVAILABLE",
      });
      expect(callCount).toBe(2);

      const updated = await getTaskById(pool, taskId);
      expect(updated?.status).toBe("AWAITING_FUNDING");
      expect(updated?.fundingTxHash).toBeNull();
    });

    it("under real concurrency, exactly one of two tasks racing to fund with the same txHash succeeds; the other gets TRANSACTION_ALREADY_USED, not a thrown/unhandled error (Codex round 1 P1)", async () => {
      const token = await login(requester);
      const taskAId = await createDraft(token);
      const taskBId = await createDraft(token);
      await postFundingIntent(token, taskAId);
      await postFundingIntent(token, taskBId);

      const taskA = await getTaskById(pool, taskAId);
      const taskB = await getTaskById(pool, taskBId);
      if (!taskA || !taskB) throw new Error("task not found");

      const sharedTxHash = ("0x" + "c".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSecondsA = BigInt(Math.floor(taskA.deliveryDeadline.getTime() / 1000));
      const deliveryDeadlineSecondsB = BigInt(Math.floor(taskB.deliveryDeadline.getTime() / 1000));

      const receiptA: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain: deriveOnChainTaskId(taskAId),
            requester: taskA.requesterAddress as `0x${string}`,
            token: taskA.token as `0x${string}`,
            budget: BigInt(taskA.budget),
            deliveryDeadlineSeconds: deliveryDeadlineSecondsA,
          }),
        ],
      };
      const receiptB: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain: deriveOnChainTaskId(taskBId),
            requester: taskB.requesterAddress as `0x${string}`,
            token: taskB.token as `0x${string}`,
            budget: BigInt(taskB.budget),
            deliveryDeadlineSeconds: deliveryDeadlineSecondsB,
          }),
        ],
      };
      const rpcA = buildFakeRpc({ receipt: receiptA, currentBlockNumber: 100n });
      const rpcB = buildFakeRpc({ receipt: receiptB, currentBlockNumber: 100n });

      // Genuinely concurrent — Promise.all, not two sequential awaits — so
      // both calls' pre-transaction checkTransactionNotUsed pre-checks can
      // both observe "not used yet" before either has committed, which is
      // exactly the race the transaction-level ON CONFLICT + occupant check
      // must resolve safely.
      const [resultA, resultB] = await Promise.all([
        verifyFunding(pool, rpcA, requester.address, taskAId, sharedTxHash),
        verifyFunding(pool, rpcB, requester.address, taskBId, sharedTxHash),
      ]);

      const results = [resultA, resultB];
      const succeeded = results.filter((r) => r.ok);
      const conflicted = results.filter((r) => !r.ok);
      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      expect(conflicted[0]).toMatchObject({
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
      });

      const chainTxRows = await pool.query(
        `SELECT task_id FROM chain_transactions WHERE chain_id = $1 AND tx_hash = $2`,
        [Number(TEST_CHAIN_ID), sharedTxHash],
      );
      expect(chainTxRows.rows).toHaveLength(1);

      const winnerTaskId = chainTxRows.rows[0].task_id as string;
      const loserTaskId = winnerTaskId === taskAId ? taskBId : taskAId;

      const winner = await getTaskById(pool, winnerTaskId);
      const loser = await getTaskById(pool, loserTaskId);
      expect(winner?.status).toBe("OPEN");
      expect(winner?.fundingTxHash).toBe(sharedTxHash);
      expect(loser?.status).toBe("AWAITING_FUNDING");
      expect(loser?.fundingTxHash).toBeNull();
    });

    it("insertChainTransaction: under a deterministic (not timing-dependent) race — two open transactions both attempting to claim the same (chainId, txHash) — the second reports inserted=false instead of throwing a raw unique-violation, and findChainTransactionOwner reveals the real owner (P1 mechanism, isolated from RPC/event-loop timing)", async () => {
      // The Promise.all test above exercises the real end-to-end path, but
      // whether it actually hits the DB-level race window depends on how
      // the Node event loop happens to interleave two verifyFunding calls
      // against a real Postgres connection — not guaranteed on every run/
      // machine. This test instead forces the exact race deterministically
      // by holding two transactions open at once with explicit BEGIN/COMMIT
      // control, directly exercising the mechanism the P1 fix depends on:
      // `insertChainTransaction`'s `ON CONFLICT (chain_id, tx_hash) DO
      // NOTHING` + `findChainTransactionOwner`'s occupant lookup.
      const token = await login(requester);
      const taskAId = await createDraft(token);
      const taskBId = await createDraft(token);
      const chainId = Number(TEST_CHAIN_ID);
      const txHash = ("0x" + "d".repeat(64)) as `0x${string}`;

      const clientA = await pool.connect();
      const clientB = await pool.connect();
      try {
        await clientA.query("BEGIN");
        await clientB.query("BEGIN");

        // A claims the row first, inside its own still-open transaction.
        const insertedA = await insertChainTransaction(clientA, {
          txHash,
          chainId,
          taskId: taskAId,
          purpose: "FUNDING",
          status: "confirmed",
          confirmations: 1,
        });
        expect(insertedA).toBe(true);

        // B attempts the same (chainId, txHash) for a *different* task
        // while A's transaction is still open and uncommitted. Postgres
        // makes B's INSERT wait on A's still-in-flight unique-index entry
        // rather than immediately erroring — this `await` only resolves
        // once A commits or rolls back, which is what makes this
        // deterministic rather than a timing gamble.
        const insertedBPromise = insertChainTransaction(clientB, {
          txHash,
          chainId,
          taskId: taskBId,
          purpose: "FUNDING",
          status: "confirmed",
          confirmations: 1,
        });

        await clientA.query("COMMIT");

        // Now that A has committed, B's conflicting INSERT resolves: with
        // `ON CONFLICT DO NOTHING` this must be `false` (no row created,
        // no exception) — the pre-fix plain INSERT would instead reject
        // this `await` with a raw `23505` unique-violation error.
        const insertedB = await insertedBPromise;
        expect(insertedB).toBe(false);
        await clientB.query("COMMIT");

        const owner = await findChainTransactionOwner(pool, chainId, txHash);
        expect(owner).toBe(taskAId);
      } finally {
        clientA.release();
        clientB.release();
      }
    });

    it("is idempotent: resubmitting the same successful txHash after OPEN does not insert a second chain_transactions/chain_events row (F-606)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "5".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));

      const receipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget),
            deliveryDeadlineSeconds,
          }),
        ],
      };
      const rpc = buildFakeRpc({ receipt, currentBlockNumber: 100n });

      const first = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
      expect(first).toEqual({ ok: true, status: "OPEN", confirmations: 1 });

      const second = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
      expect(second).toEqual({ ok: true, status: "OPEN", confirmations: 1 });

      const chainTx = await pool.query(
        `SELECT count(*)::int AS count FROM chain_transactions WHERE task_id = $1`,
        [taskId],
      );
      expect(chainTx.rows[0].count).toBe(1);

      const chainEvents = await pool.query(
        `SELECT count(*)::int AS count FROM chain_events WHERE task_id = $1`,
        [taskId],
      );
      expect(chainEvents.rows[0].count).toBe(1);
    });

    it("rejects a txHash already bound to a different task with TRANSACTION_ALREADY_USED and does not change status (F-605/AC-603)", async () => {
      const token = await login(requester);
      const taskAId = await createDraft(token);
      const taskBId = await createDraft(token);
      await postFundingIntent(token, taskAId);
      await postFundingIntent(token, taskBId);

      const taskA = await getTaskById(pool, taskAId);
      const taskB = await getTaskById(pool, taskBId);
      if (!taskA || !taskB) throw new Error("task not found");

      const sharedTxHash = ("0x" + "6".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSecondsA = BigInt(Math.floor(taskA.deliveryDeadline.getTime() / 1000));

      // Fund task A successfully with sharedTxHash.
      const receiptA: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain: deriveOnChainTaskId(taskAId),
            requester: taskA.requesterAddress as `0x${string}`,
            token: taskA.token as `0x${string}`,
            budget: BigInt(taskA.budget),
            deliveryDeadlineSeconds: deliveryDeadlineSecondsA,
          }),
        ],
      };
      const rpcA = buildFakeRpc({ receipt: receiptA, currentBlockNumber: 100n });
      const fundedA = await verifyFunding(pool, rpcA, requester.address, taskAId, sharedTxHash);
      expect(fundedA).toEqual({ ok: true, status: "OPEN", confirmations: 1 });

      // Now try to reuse the exact same txHash for task B — even though the
      // fake RPC would decode task B's own event fine (address/topics match
      // task B's expectations), the tx is already claimed by task A.
      const deliveryDeadlineSecondsB = BigInt(Math.floor(taskB.deliveryDeadline.getTime() / 1000));
      const receiptB: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain: deriveOnChainTaskId(taskBId),
            requester: taskB.requesterAddress as `0x${string}`,
            token: taskB.token as `0x${string}`,
            budget: BigInt(taskB.budget),
            deliveryDeadlineSeconds: deliveryDeadlineSecondsB,
          }),
        ],
      };
      const rpcB = buildFakeRpc({ receipt: receiptB, currentBlockNumber: 100n });
      const result = await verifyFunding(pool, rpcB, requester.address, taskBId, sharedTxHash);
      expect(result).toMatchObject({
        ok: false,
        reason: "chain_error",
        code: "TRANSACTION_ALREADY_USED",
      });

      const updatedB = await getTaskById(pool, taskBId);
      expect(updatedB?.status).toBe("AWAITING_FUNDING");
      expect(updatedB?.fundingTxHash).toBeNull();
    });

    it("returns not_found for verifyFunding on a nonexistent task, and forbidden for a non-owner", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const rpc = buildFakeRpc();
      const missing = await verifyFunding(
        pool,
        rpc,
        requester.address,
        "00000000-0000-4000-8000-000000000000",
        ("0x" + "7".repeat(64)) as `0x${string}`,
      );
      expect(missing).toEqual({ ok: false, reason: "not_found" });

      const forbidden = await verifyFunding(
        pool,
        rpc,
        stranger.address,
        taskId,
        ("0x" + "8".repeat(64)) as `0x${string}`,
      );
      expect(forbidden).toEqual({ ok: false, reason: "forbidden" });
    });

    it("createFundingIntent returns not_found/forbidden directly, mirroring verifyFunding's checks", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      const missing = await createFundingIntent(
        pool,
        requester.address,
        "00000000-0000-4000-8000-000000000000",
      );
      expect(missing).toEqual({ ok: false, reason: "not_found" });

      const forbidden = await createFundingIntent(pool, stranger.address, taskId);
      expect(forbidden).toEqual({ ok: false, reason: "forbidden" });
    });

    it("resolves chain config before transitioning DRAFT -> AWAITING_FUNDING, so a config failure never strands the task (Codex round 2 P1)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);

      const savedEscrowAddress = process.env.TASK_ESCROW_ADDRESS;
      // The zero-address .env.example placeholder — resolveChainConfig
      // (packages/domain/src/chain-config.ts) explicitly throws on it.
      process.env.TASK_ESCROW_ADDRESS = "0x0000000000000000000000000000000000000000";
      try {
        await expect(createFundingIntent(pool, requester.address, taskId)).rejects.toThrow();
      } finally {
        process.env.TASK_ESCROW_ADDRESS = savedEscrowAddress;
      }

      // The failed call above must NOT have committed the DRAFT ->
      // AWAITING_FUNDING transition — the task must still be editable/
      // re-triable as a DRAFT, not permanently stuck.
      const afterFailure = await getTaskById(pool, taskId);
      expect(afterFailure?.status).toBe("DRAFT");

      // With config restored, a retry succeeds normally.
      const retry = await createFundingIntent(pool, requester.address, taskId);
      expect(retry.ok).toBe(true);
      const afterRetry = await getTaskById(pool, taskId);
      expect(afterRetry?.status).toBe("AWAITING_FUNDING");
    });

    it("does not record a funding event from a receipt snapshot that changed between the two RPC reads (reorg-consistency, Codex round 2 P1)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "1".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));

      const verifiedReceipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget),
            deliveryDeadlineSeconds,
          }),
        ],
      };
      // A DIFFERENT blockHash on the second fetch — simulates a reorg (or an
      // inconsistent RPC) happening between `verifyFundingTransaction`'s own
      // receipt read and `verifyFunding`'s second read for `logIndex`. Same
      // logs/content, deliberately different `blockHash` so the fix's
      // equality check is what's actually being exercised, not a decode
      // failure.
      const staleSnapshotReceipt: TransactionReceiptResult = {
        ...verifiedReceipt,
        blockHash: "0x" + "c".repeat(64),
      };
      let callCount = 0;
      const rpc: ChainRpcClient = {
        async getTransactionReceipt() {
          callCount += 1;
          return callCount === 1 ? verifiedReceipt : staleSnapshotReceipt;
        },
        async getBlockNumber() {
          return 100n;
        },
        async getBlock() {
          return { hash: verifiedReceipt.blockHash, number: 100n };
        },
        async getChainId() {
          return Number(TEST_CHAIN_ID);
        },
        async getTransaction() {
          throw new Error("getTransaction: not used by funding verification");
        },
        async readStakeRateBps() {
          throw new Error("readStakeRateBps: not used by funding verification");
        },
        // Feature 7 sync (T-709): unused by funding verification — see above.
        async readAuthorizedSigner() {
          throw new Error("readAuthorizedSigner: not used by funding verification");
        },
        async readHasRole() {
          throw new Error("readHasRole: not used by funding verification");
        },
      };

      const result = await verifyFunding(pool, rpc, requester.address, taskId, txHash);
      expect(result).toEqual({
        ok: false,
        reason: "chain_error",
        code: "RPC_TEMPORARILY_UNAVAILABLE",
        message: expect.any(String),
      });

      const updated = await getTaskById(pool, taskId);
      expect(updated?.status).toBe("AWAITING_FUNDING");
      const chainEvents = await pool.query(`SELECT * FROM chain_events WHERE task_id = $1`, [
        taskId,
      ]);
      expect(chainEvents.rows).toHaveLength(0);
    });

    // Whether this actually drives both calls' initial `getTaskById` reads
    // to land before either commits depends on Node event-loop/Postgres
    // round-trip timing on this machine, not guaranteed on every run.
    // Verified (fault injection): with the P2 fix in service.ts reverted,
    // this specific test did not fail across repeated local runs — it did
    // not reliably land in the race window. The controlled lock-contention
    // test immediately below is what actually load-bears the P2 regression
    // guarantee, by forcing the intended ordering with an explicit
    // BEGIN/FOR UPDATE/COMMIT-held lock instead of relying on Promise.all
    // timing alone (though it still uses a fixed delay to give the other
    // side time to reach that lock — see its own note). Kept here anyway as
    // a best-effort real-concurrency exercise.
    it("is idempotent under real concurrency for the SAME task + txHash: both concurrent verifyFunding calls succeed, only one set of rows is recorded (Codex round 2 P2)", async () => {
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "9".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));
      const receipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget),
            deliveryDeadlineSeconds,
          }),
        ],
      };
      const rpc = buildFakeRpc({ receipt, currentBlockNumber: 100n });

      const [first, second] = await Promise.all([
        verifyFunding(pool, rpc, requester.address, taskId, txHash),
        verifyFunding(pool, rpc, requester.address, taskId, txHash),
      ]);

      // Neither call may fail — this is the SAME task and the SAME
      // transaction racing against itself, not two different tasks
      // claiming the same txHash (that's the TRANSACTION_ALREADY_USED
      // case, covered separately).
      expect(first).toEqual({ ok: true, status: "OPEN", confirmations: 1 });
      expect(second).toEqual({ ok: true, status: "OPEN", confirmations: 1 });

      const updated = await getTaskById(pool, taskId);
      expect(updated?.status).toBe("OPEN");

      const chainTx = await pool.query(`SELECT * FROM chain_transactions WHERE task_id = $1`, [
        taskId,
      ]);
      expect(chainTx.rows).toHaveLength(1);
      const chainEvents = await pool.query(`SELECT * FROM chain_events WHERE task_id = $1`, [
        taskId,
      ]);
      expect(chainEvents.rows).toHaveLength(1);
    });

    it("controlled lock-contention test: forces the SAME-task conflict window so a verifyFunding call that loses the row-lock race to an already-committed OPEN transition for the same txHash still succeeds instead of returning a conflict (Codex round 2 P2)", async () => {
      // Holds a `FOR UPDATE` lock open in a manually-controlled transaction
      // so `verifyFunding`'s call to `transitionTaskStatus` blocks on it,
      // then observes the row AFTER a "concurrent winner" has already moved
      // it to OPEN with the exact same txHash — the precise scenario the P2
      // fix (re-check `funding_tx_hash` on an OPEN conflict) exists to
      // handle. NOTE: unlike the insertChainTransaction race test above
      // (which blocks on Postgres's own lock wait with no timing assumption
      // at all), this test is NOT fully timing-independent — it still relies
      // on the `setTimeout` margin below to let `verifyFunding` reach its own
      // `FOR UPDATE` attempt before the lock is released. Call it a
      // controlled lock-contention test, not a strictly deterministic one:
      // the lock itself is real and does force the intended ordering once
      // `verifyFunding` reaches it, but nothing here proves it reaches that
      // point within the margin on every machine. A future improvement would
      // replace the fixed delay with an explicit signal (a test hook, or
      // polling `pg_stat_activity` for the blocked query) rather than a
      // guessed duration.
      const token = await login(requester);
      const taskId = await createDraft(token);
      await postFundingIntent(token, taskId);

      const task = await getTaskById(pool, taskId);
      if (!task) throw new Error("task not found");
      const taskIdOnChain = deriveOnChainTaskId(taskId);
      const txHash = ("0x" + "e".repeat(64)) as `0x${string}`;
      const deliveryDeadlineSeconds = BigInt(Math.floor(task.deliveryDeadline.getTime() / 1000));
      const receipt: TransactionReceiptResult = {
        status: "success",
        to: TASK_ESCROW_ADDRESS,
        blockNumber: 100n,
        blockHash: "0x" + "b".repeat(64),
        logs: [
          buildFundedLog({
            taskIdOnChain,
            requester: task.requesterAddress as `0x${string}`,
            token: task.token as `0x${string}`,
            budget: BigInt(task.budget),
            deliveryDeadlineSeconds,
          }),
        ],
      };
      const rpc = buildFakeRpc({ receipt, currentBlockNumber: 100n });

      const lockHolder = await pool.connect();
      try {
        await lockHolder.query("BEGIN");
        // Takes the row lock first — this is what `verifyFunding`'s own
        // `transitionTaskStatus` will block on once it reaches its own
        // `SELECT ... FOR UPDATE`. A plain (non-locking) `SELECT` — which
        // is all `verifyFunding`'s initial `getTaskById` does — still reads
        // the pre-commit `AWAITING_FUNDING` state under READ COMMITTED, so
        // starting `verifyFunding` now reproduces "the other request already
        // observed AWAITING_FUNDING before losing the race."
        await lockHolder.query(`SELECT status FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);

        const verifyPromise = verifyFunding(pool, rpc, requester.address, taskId, txHash);

        // Give verifyFunding's own connection time to reach its blocked
        // `FOR UPDATE` inside `transitionTaskStatus` (everything before that
        // — getTaskById, the fake-RPC-backed verification, the pre-check —
        // has no real work to wait on, so this margin only needs to cover a
        // couple of fast local Postgres round-trips).
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Simulate the "concurrent winner": commits the exact transition
        // `transitionTaskStatus` would have performed for a first, already-
        // successful call with this same txHash — status, history row, and
        // the chain_transactions/chain_events rows all in place — then
        // releases the lock.
        await lockHolder.query(
          `UPDATE tasks SET status = 'OPEN', funding_tx_hash = $2, updated_at = now() WHERE id = $1`,
          [taskId, txHash],
        );
        await lockHolder.query(
          `INSERT INTO task_state_history (task_id, from_status, to_status, actor, reason)
           VALUES ($1, 'AWAITING_FUNDING', 'OPEN', $2, 'simulated concurrent winner')`,
          [taskId, task.requesterAddress],
        );
        await insertChainTransaction(lockHolder, {
          txHash,
          chainId: Number(TEST_CHAIN_ID),
          taskId,
          purpose: "FUNDING",
          status: "confirmed",
          confirmations: 1,
        });
        await lockHolder.query("COMMIT");

        // Now that the lock is released, verifyFunding's blocked
        // `transitionTaskStatus` call unblocks, sees `status = 'OPEN'`
        // (a conflict against its own `allowedFromStatuses: ["AWAITING_FUNDING"]`),
        // and — with the P2 fix — recognizes `funding_tx_hash` matches this
        // call's own txHash, returning success instead of a conflict.
        const result = await verifyPromise;
        expect(result).toEqual({ ok: true, status: "OPEN", confirmations: 1 });
      } finally {
        lockHolder.release();
      }

      // Exactly one chain_transactions/chain_events row — the "loser" must
      // not have written a second one.
      const chainTx = await pool.query(`SELECT * FROM chain_transactions WHERE task_id = $1`, [
        taskId,
      ]);
      expect(chainTx.rows).toHaveLength(1);
    });
  },
);
