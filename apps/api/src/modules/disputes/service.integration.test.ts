import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import type { ChainRpcClient } from "../chain/rpc.client.js";
import { computeEvidenceHash } from "./evidence-hash.js";
import { insertDispute } from "./repository.js";
import { getDisputeView } from "./service.js";

/**
 * Real-DB test for `getDisputeView` — T-1002's human-review fix (Codex
 * round 2, P1): `GET /tasks/:taskId/disputes` previously returned
 * `evidenceSummary` to any anonymous or unrelated caller. This suite
 * covers all five viewer categories the fix must distinguish: anonymous,
 * a logged-in but unrelated user, the requester, the accepted Agent, and
 * an on-chain-verified arbitrator — with an explicit assertion that
 * `evidenceSummary`/`evidenceHash` are absent from every unauthorized
 * response. Skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1
 * against a confirmed-safe TEST_DATABASE_URL, same as every other
 * `*.integration.test.ts` suite. The arbitrator path is exercised here
 * (with a fake `ChainRpcClient`'s `readHasRole`) rather than at the full
 * HTTP layer — same "chain-touching service function tested directly,
 * route just wires it to HTTP" convention `settlement.integration.test.ts`
 * and `tasks/disputes.integration.test.ts` already establish, since
 * `disputes/routes.ts`'s HTTP layer always constructs a real
 * `createChainRpcClient()` with no injection seam (matching every other
 * route in this codebase).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE";

const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
const TEST_CHAIN_ID = "31337";

function buildFakeRpc(isArbitrator: (account: string) => boolean): ChainRpcClient {
  return {
    async getTransactionReceipt() {
      throw new Error("not used by getDisputeView");
    },
    async getBlockNumber() {
      throw new Error("not used by getDisputeView");
    },
    async getBlock() {
      throw new Error("not used by getDisputeView");
    },
    async getChainId() {
      throw new Error("not used by getDisputeView");
    },
    async getTransaction() {
      throw new Error("not used by getDisputeView");
    },
    async readStakeRateBps() {
      throw new Error("not used by getDisputeView");
    },
    async readAuthorizedSigner() {
      throw new Error("not used by getDisputeView");
    },
    async readHasRole(_contractAddress, _role, account) {
      return isArbitrator(account);
    },
  };
}

/** Simulates the on-chain role check itself failing (RPC unreachable,
 * node error, etc.) — T-1002 human-review fix round 2, P2's own scenario:
 * `getDisputeView` must fail CLOSED to the public projection when this
 * throws, never propagate the error up as a 500-equivalent failure. */
function buildThrowingFakeRpc(error: Error): ChainRpcClient {
  return {
    async getTransactionReceipt() {
      throw new Error("not used by getDisputeView");
    },
    async getBlockNumber() {
      throw new Error("not used by getDisputeView");
    },
    async getBlock() {
      throw new Error("not used by getDisputeView");
    },
    async getChainId() {
      throw new Error("not used by getDisputeView");
    },
    async getTransaction() {
      throw new Error("not used by getDisputeView");
    },
    async readStakeRateBps() {
      throw new Error("not used by getDisputeView");
    },
    async readAuthorizedSigner() {
      throw new Error("not used by getDisputeView");
    },
    async readHasRole() {
      throw error;
    },
  };
}

runIfOptedIn("getDisputeView (integration, T-1002 human-review fix)", () => {
  let pool: Pool;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const arbitrator = privateKeyToAccount(generatePrivateKey());
  const unrelated = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    process.env.CHAIN_ID = TEST_CHAIN_ID;
    process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
    process.env.YD_TOKEN_ADDRESS = YD_TOKEN_ADDRESS;
    process.env.YD_FAUCET_ADDRESS = YD_FAUCET_ADDRESS;

    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM users");
  });

  async function insertTaskWithOpenDispute(): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [agent.address.toLowerCase()],
    );
    const agentId = agentRows[0]?.id;
    if (!agentId) throw new Error("insertTaskWithOpenDispute: no agent id returned");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline,
          status, accepted_agent_address, accepted_agent_id, accepted_at)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', 'SUBMITTED', $3, $4, now())
       RETURNING id`,
      [requester.address.toLowerCase(), YD_TOKEN_ADDRESS, agent.address.toLowerCase(), agentId],
    );
    const taskId = rows[0]?.id;
    if (!taskId) throw new Error("insertTaskWithOpenDispute: no task id returned");

    const evidenceHash = computeEvidenceHash("private evidence text");
    const dispute = await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "quality dispute",
      evidenceSummary: "private evidence text",
      evidenceHash,
    });
    if (!dispute) throw new Error("insertTaskWithOpenDispute: insertDispute returned null");

    return taskId;
  }

  const rpcArbitratorOnly = buildFakeRpc(
    (account) => account.toLowerCase() === arbitrator.address.toLowerCase(),
  );

  it("anonymous (null sessionAddress): public projection only, evidenceSummary/evidenceHash absent", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const result = await getDisputeView(pool, () => rpcArbitratorOnly, null, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.status).toBe("OPEN");
    expect(result.view.evidenceSummary).toBeUndefined();
    expect(result.view.evidenceHash).toBeUndefined();
  });

  it("never constructs an RPC client or resolves chain config for anonymous/requester/agent viewers — succeeds even with chain env vars unset", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const savedChainId = process.env.CHAIN_ID;
    const savedTaskEscrow = process.env.TASK_ESCROW_ADDRESS;
    delete process.env.CHAIN_ID;
    delete process.env.TASK_ESCROW_ADDRESS;
    const throwingRpcFactory = () => {
      throw new Error(
        "getRpc must not be called for a viewer resolved before the arbitrator check",
      );
    };
    try {
      const anonymous = await getDisputeView(pool, throwingRpcFactory, null, taskId);
      expect(anonymous.ok).toBe(true);
      const asRequester = await getDisputeView(pool, throwingRpcFactory, requester.address, taskId);
      expect(asRequester.ok && asRequester.view.evidenceSummary).toBe("private evidence text");
      const asAgent = await getDisputeView(pool, throwingRpcFactory, agent.address, taskId);
      expect(asAgent.ok && asAgent.view.evidenceSummary).toBe("private evidence text");
    } finally {
      if (savedChainId === undefined) delete process.env.CHAIN_ID;
      else process.env.CHAIN_ID = savedChainId;
      if (savedTaskEscrow === undefined) delete process.env.TASK_ESCROW_ADDRESS;
      else process.env.TASK_ESCROW_ADDRESS = savedTaskEscrow;
    }
  });

  it("logged-in but unrelated user (not requester/agent/arbitrator): public projection only", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const result = await getDisputeView(pool, () => rpcArbitratorOnly, unrelated.address, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.evidenceSummary).toBeUndefined();
    expect(result.view.evidenceHash).toBeUndefined();
  });

  it("the task's requester: full projection, evidenceSummary present", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const result = await getDisputeView(pool, () => rpcArbitratorOnly, requester.address, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.evidenceSummary).toBe("private evidence text");
    expect(result.view.evidenceHash).toBeTruthy();
  });

  it("the task's accepted Agent: full projection, evidenceSummary present", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const result = await getDisputeView(pool, () => rpcArbitratorOnly, agent.address, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.evidenceSummary).toBe("private evidence text");
  });

  it("an on-chain-verified arbitrator (readHasRole true): full projection, evidenceSummary present", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const result = await getDisputeView(pool, () => rpcArbitratorOnly, arbitrator.address, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.evidenceSummary).toBe("private evidence text");
  });

  it("a self-claimed arbitrator address that readHasRole rejects: public projection only — never trusts a self-reported identity", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const rpcNeverArbitrator = buildFakeRpc(() => false);
    const result = await getDisputeView(pool, () => rpcNeverArbitrator, arbitrator.address, taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.evidenceSummary).toBeUndefined();
  });

  it("logged-in but unrelated user, readHasRole throws (RPC/chain unavailable): fails CLOSED to public projection, not a 500-equivalent failure (T-1002 human-review fix round 2, P2)", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const rpcThrows = buildThrowingFakeRpc(new Error("RPC connection refused"));
    const observedErrors: unknown[] = [];

    const result = await getDisputeView(
      pool,
      () => rpcThrows,
      unrelated.address,
      taskId,
      (error) => observedErrors.push(error),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.status).toBe("OPEN");
    expect(result.view.evidenceSummary).toBeUndefined();
    expect(result.view.evidenceHash).toBeUndefined();
    expect(observedErrors).toHaveLength(1);
  });

  it("the real arbitrator's own address, readHasRole throws: STILL fails CLOSED to public — an unproven on-chain claim is never granted full access, even for the address that would otherwise qualify", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const rpcThrows = buildThrowingFakeRpc(new Error("chain config missing"));

    const result = await getDisputeView(pool, () => rpcThrows, arbitrator.address, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.view.evidenceSummary).toBeUndefined();
    expect(result.view.evidenceHash).toBeUndefined();
  });

  it("returns task_not_found for a nonexistent task", async () => {
    const result = await getDisputeView(
      pool,
      () => rpcArbitratorOnly,
      null,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(result).toEqual({ ok: false, reason: "task_not_found" });
  });

  it("returns dispute_not_found when the task has no dispute", async () => {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', 'SUBMITTED') RETURNING id`,
      [requester.address.toLowerCase(), YD_TOKEN_ADDRESS],
    );
    const taskId = rows[0]?.id;
    if (!taskId) throw new Error("no task id returned");

    const result = await getDisputeView(pool, () => rpcArbitratorOnly, null, taskId);
    expect(result).toEqual({ ok: false, reason: "dispute_not_found" });
  });
});
