import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../app.js";
import { runMigrations } from "../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../modules/auth/signInMessage.js";

/**
 * T-1007 — Feature 10's own real end-to-end evidence (PRD §16.5 scenarios
 * 3/4/5/6/7, plus §17.2's "重复交易哈希"/"RPC 暂时失败" evidence and this
 * Feature's own AC-1004/AC-1008/AC-1002's real-chain proof). Same real
 * infrastructure `deliverable-submission.hardhat.e2e.test.ts` (T-906)
 * established: a real `hardhat node` JSON-RPC server, real deployed
 * `YDToken`/`TaskEscrow` contracts (from this repo's own compiled
 * artifacts), a real Postgres database, and the exact same production
 * Fastify app (`buildApp()`) every other route in this backend runs
 * through — `app.inject()` calls the real HTTP routes, which internally
 * build a real `createChainRpcClient()` against the real spawned node and
 * independently re-fetch + re-decode real transaction receipts. Nothing
 * here is a hand-constructed event log or a fake `ChainRpcClient`.
 *
 * Layered opt-in identical to T-906's own: `RUN_DB_INTEGRATION_TESTS=1` +
 * `TEST_DATABASE_URL` + `RUN_HARDHAT_E2E_TESTS=1`.
 *
 * Test matrix (failure criteria: any assertion below failing, any
 * unexpected revert, any HTTP status/body mismatch, or any DB value
 * diverging from the real decoded on-chain event):
 *
 *  1. 正常验收放款 (approveResult): real requester approves a real
 *     submitted result → agent's real YD balance increases by exactly
 *     budget+stake, tasks.status=RELEASED, agents stats
 *     completed+1/success+1/overdue+0, quality_score untouched (still
 *     null pre-rating).
 *  2. 交付超时退款 (claimDeliveryTimeout): agent never submits, real chain
 *     time fast-forwarded past deliveryDeadline → requester's real YD
 *     balance increases by budget+stake, tasks.status=REFUNDED, stats
 *     completed+1/success+0/overdue+1.
 *  3. 验收超时放款 (finalizeReviewTimeout): real chain time fast-forwarded
 *     past reviewDeadline, called by an unrelated THIRD wallet
 *     (permissionless) → agent's real YD balance increases by
 *     budget+stake, tasks.status=RELEASED, stats
 *     completed+1/success+1/overdue+0.
 *  4. 争议→仲裁支持 Agent: real openDispute (off-chain record via
 *     POST /tasks/:taskId/disputes, then the on-chain call referencing
 *     its returned evidenceHash) → real resolveDispute(true) signed by
 *     the real on-chain ARBITRATOR_ROLE holder → agent's real YD balance
 *     increases by budget+stake, tasks.status=RELEASED,
 *     disputes.status=RESOLVED/resolution=SUPPORT_AGENT, stats
 *     completed+1/success+1/overdue+0.
 *  5. 争议→仲裁支持需求方: same setup, resolveDispute(false) → requester's
 *     real YD balance increases by budget+stake, tasks.status=REFUNDED,
 *     disputes.resolution=SUPPORT_REQUESTER, stats
 *     completed+1/success+0/overdue+0 (NOT overdue+1 — AC-1008).
 *  6. 重复 txHash 幂等: replay scenario 1's own real settlement txHash
 *     through the real verification route a second time → same 200
 *     response, `chain_transactions` still has exactly one row for that
 *     hash, stats not double-incremented.
 *  7. RPC 暂时失败恢复: point `BACKEND_RPC_URL` at an unreachable port for
 *     one real verification call → real 202 RPC_TEMPORARILY_UNAVAILABLE;
 *     restore the real URL and retry the SAME real txHash → real 200
 *     success.
 *  8. 评分规则: after scenario 1's real RELEASED task, the real requester
 *     submits a 1-5 score exactly once via the real
 *     `POST /tasks/:taskId/ratings` — a second attempt (same requester)
 *     and a non-requester attempt both real-409/403; `agents.quality_score`
 *     is recomputed to the exact real normalized value; `GET
 *     /tasks/:taskId/ratings` returns it publicly.
 *  9. 争议证据隐私: for scenario 4's real disputed/resolved task, `GET
 *     /tasks/:taskId/disputes` never includes `evidenceSummary` for an
 *     anonymous caller or an unrelated signed-in wallet, but DOES for the
 *     requester, the accepted Agent, and the real on-chain
 *     ARBITRATOR_ROLE holder (verified via a REAL `hasRole` read against
 *     the deployed contract, not a mocked role check).
 *
 * Deliberately NOT re-covered here (already real/integration-tested by
 * earlier Features, cited in the T-1007 evidence README rather than
 * duplicated): 错误网络/错误金额 funding rejection (Feature 6, T-605/T-606),
 * 并发接单 (Feature 8, T-801/T-802's own concurrency test), file-hash/
 * reviewDeadline byte-equality (Feature 9, T-906 — this file's own sibling
 * above).
 */
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_HARDHAT_E2E_TESTS === "1"
    ? describe
    : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const contractsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../contracts",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, schema_migrations CASCADE";

// Same well-known deterministic Hardhat Network default accounts T-906
// already uses — publicly documented, hold no real value.
const HARDHAT_ACCOUNT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;

const REVIEW_WINDOW_SECONDS = 259_200; // 72h — matches T-906's own deployment.

function readArtifact(relativePath: string): { abi: unknown; bytecode: Hex } {
  const raw = readFileSync(path.join(contractsDir, relativePath), "utf8");
  const parsed = JSON.parse(raw) as { abi: unknown; bytecode: string };
  return { abi: parsed.abi, bytecode: parsed.bytecode as Hex };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("getFreePort: failed to acquire a free TCP port"));
      }
    });
  });
}

async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `waitForRpcReady: hardhat node at ${rpcUrl} never became ready within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

runIfOptedIn("Feature 10 full lifecycle (real Hardhat e2e, T-1007, PRD §16.5/§17.2)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let hardhatProcess: ChildProcessByStdio<null, Readable, Readable>;
  let hardhatStderr = "";
  let rpcUrl: string;
  let chainId: number;
  let ydTokenAddress: `0x${string}`;
  let escrowAddress: `0x${string}`;
  let publicClient: PublicClient;
  let ydTokenAbi: unknown;
  let escrowAbi: unknown;

  const previousEnv: Partial<Record<string, string | undefined>> = {};
  const MANAGED_ENV_KEYS = [
    "BACKEND_RPC_URL",
    "FUNDING_REQUIRED_CONFIRMATIONS",
    "CHAIN_ID",
    "YD_FAUCET_ADDRESS",
    "YD_TOKEN_ADDRESS",
    "TASK_ESCROW_ADDRESS",
  ] as const;

  function setManagedEnv(key: (typeof MANAGED_ENV_KEYS)[number], value: string): void {
    if (!(key in previousEnv)) {
      previousEnv[key] = process.env[key];
    }
    process.env[key] = value;
  }

  const deployer = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[0]);
  const requester = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[1]);
  const agent = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[2]);
  const authorizedSigner = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[3]);
  const arbitrator = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[4]);
  // A wallet with NO relationship to any task this suite creates — used
  // for scenario 9's "unrelated signed-in viewer" privacy check. Never
  // needs real ETH/YD (only ever signs an off-chain SIWE message).
  const unrelatedUser = privateKeyToAccount(generatePrivateKey());

  let nextTaskKeySeed = 0;
  let nextPermitNonce = BigInt(Date.now()) * 1000n;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);

    const port = await getFreePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    hardhatProcess = spawn(
      path.join(contractsDir, "node_modules/.bin/hardhat"),
      ["node", "--port", String(port), "--hostname", "127.0.0.1"],
      { cwd: contractsDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    hardhatProcess.stderr.on("data", (chunk: Buffer) => {
      hardhatStderr += chunk.toString();
    });
    const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
      hardhatProcess.once("error", reject);
    });
    try {
      await Promise.race([waitForRpcReady(rpcUrl, 30_000), spawnErrorPromise]);
    } catch (error) {
      throw new Error(`${String(error)}\nhardhat node stderr:\n${hardhatStderr}`);
    }

    setManagedEnv("BACKEND_RPC_URL", rpcUrl);
    setManagedEnv("FUNDING_REQUIRED_CONFIRMATIONS", "1");

    publicClient = createPublicClient({ transport: http(rpcUrl) });
    chainId = await publicClient.getChainId();
    setManagedEnv("CHAIN_ID", String(chainId));
    setManagedEnv("YD_FAUCET_ADDRESS", "0x9876543210987654321098765432109876543210");

    const deployerWallet = createWalletClient({ account: deployer, transport: http(rpcUrl) });

    const ydTokenArtifact = readArtifact("artifacts/src/YDToken.sol/YDToken.json");
    ydTokenAbi = ydTokenArtifact.abi;
    const initialSupply = 10_000_000n * 10n ** 18n;
    const ydTokenDeployHash = await deployerWallet.deployContract({
      abi: ydTokenArtifact.abi as never,
      bytecode: ydTokenArtifact.bytecode,
      args: [requester.address, initialSupply],
      chain: null,
    });
    const ydTokenReceipt = await publicClient.waitForTransactionReceipt({
      hash: ydTokenDeployHash,
    });
    if (!ydTokenReceipt.contractAddress) throw new Error("YDToken deployment produced no address");
    ydTokenAddress = ydTokenReceipt.contractAddress;
    setManagedEnv("YD_TOKEN_ADDRESS", ydTokenAddress);

    const taskEscrowArtifact = readArtifact("artifacts/src/TaskEscrow.sol/TaskEscrow.json");
    escrowAbi = taskEscrowArtifact.abi;
    const escrowDeployHash = await deployerWallet.deployContract({
      abi: taskEscrowArtifact.abi as never,
      bytecode: taskEscrowArtifact.bytecode,
      args: [ydTokenAddress, authorizedSigner.address, REVIEW_WINDOW_SECONDS, arbitrator.address],
      chain: null,
    });
    const escrowReceipt = await publicClient.waitForTransactionReceipt({
      hash: escrowDeployHash,
    });
    if (!escrowReceipt.contractAddress)
      throw new Error("TaskEscrow deployment produced no address");
    escrowAddress = escrowReceipt.contractAddress;
    setManagedEnv("TASK_ESCROW_ADDRESS", escrowAddress);

    // Fund the agent wallet with plenty of YD to stake across every
    // scenario below (each scenario uses a fresh task, so the agent
    // re-stakes multiple times over the course of this suite).
    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const transferHash = await requesterWallet.writeContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "transfer",
      args: [agent.address, 1_000_000n * 10n ** 18n],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: transferHash });

    app = buildApp({ pool, logger: false });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    hardhatProcess?.kill();
    await pool?.query(DROP_ALL_TABLES_SQL);
    await pool?.end();
    for (const key of MANAGED_ENV_KEYS) {
      const original = previousEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  async function login(account: {
    address: `0x${string}`;
    signMessage: typeof requester.signMessage;
  }): Promise<string> {
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
    if (!match?.[1]) throw new Error("login: no session_token cookie in verify response");
    return match[1];
  }

  async function insertAgentRow(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'E2E Agent', 'desc', 'writing', $1) RETURNING id`,
      [agent.address.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgentRow: no id returned");
    return id;
  }

  async function agentBalance(address: `0x${string}`): Promise<bigint> {
    return publicClient.readContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>;
  }

  async function agentStats(agentId: string): Promise<{
    completed: number;
    success: number;
    overdue: number;
    qualityScore: number | null;
  }> {
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

  /**
   * PRD §17.2's own evidence requirement ("一次完整成功交易的任务 ID、钱包
   * 地址、交易哈希和状态截图") — this suite has no browser to screenshot, so
   * each scenario prints its own real captured values (task id, on-chain
   * task id, wallet addresses, real tx hashes, real balances, real
   * resulting status) as one structured line to stdout. This IS the demo
   * script §17.2 also asks for ("可从干净环境复现的 README 和演示脚本") — a
   * human re-running this suite (`RUN_DB_INTEGRATION_TESTS=1
   * RUN_HARDHAT_E2E_TESTS=1 TEST_DATABASE_URL=... pnpm --filter
   * @agent-market/api test -- src/e2e/full-lifecycle.hardhat.e2e.test.ts`)
   * gets the exact same real evidence lines this Task's own README quotes
   * from one captured run.
   */
  function evidenceLog(scenario: string, data: Record<string, unknown>): void {
    console.log(
      `[T-1007 evidence] ${scenario}: ${JSON.stringify(
        data,
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      )}`,
    );
  }

  /**
   * Creates a fresh real accepted task: a DB row inserted directly at
   * `ACCEPTED` (Feature 6/8's own funding/acceptance flow is already
   * real-e2e-tested elsewhere — see this file's header — so this
   * shortcut starts exactly where T-906's own e2e test does) PLUS the
   * real matching on-chain `createTask`+`acceptTask` sequence against
   * the real deployed contract, so every settlement/dispute action
   * afterward is a real transaction against a real, real-fund-backed
   * task, not a DB fiction.
   */
  async function setupAcceptedTask(params: {
    agentId: string;
    deliveryWindowSeconds: bigint;
  }): Promise<{ taskId: string; taskIdOnChain: `0x${string}`; budget: bigint; stake: bigint }> {
    nextTaskKeySeed += 1;
    const budget = 1_000n * 10n ** 18n;
    const latestBlock = await publicClient.getBlock();
    const deliveryDeadlineUnix = latestBlock.timestamp + params.deliveryWindowSeconds;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
           (requester_address, category, title, description, budget, token, delivery_deadline,
            status, accepted_agent_address, accepted_agent_id, accepted_at, expert_type)
         VALUES ($1, 'writing', $2, 'desc', $3, $4, to_timestamp($5), 'ACCEPTED', $6, $7, now(), 'AUTOMATION')
         RETURNING id`,
      [
        requester.address.toLowerCase(),
        `T-1007 e2e task ${nextTaskKeySeed}`,
        budget.toString(),
        ydTokenAddress,
        Number(deliveryDeadlineUnix),
        agent.address.toLowerCase(),
        params.agentId,
      ],
    );
    const taskId = rows[0]?.id;
    if (!taskId) throw new Error("setupAcceptedTask: no id returned");
    const taskIdOnChain = keccak256(toBytes(taskId));

    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const agentWallet = createWalletClient({ account: agent, transport: http(rpcUrl) });

    const approveHash = await requesterWallet.writeContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "approve",
      args: [escrowAddress, budget],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const createTaskHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "createTask",
      args: [taskIdOnChain, ydTokenAddress, budget, deliveryDeadlineUnix],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: createTaskHash });

    nextPermitNonce += 1n;
    const permit = {
      taskId: taskIdOnChain,
      agent: agent.address,
      nonce: nextPermitNonce,
      expiry: deliveryDeadlineUnix,
      chainId: BigInt(chainId),
      verifyingContract: escrowAddress,
    };
    const permitSignature = await authorizedSigner.signTypedData({
      domain: {
        name: "AgentMarketTaskEscrow",
        version: "1",
        chainId,
        verifyingContract: escrowAddress,
      },
      types: {
        AcceptancePermit: [
          { name: "taskId", type: "bytes32" },
          { name: "agent", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
      primaryType: "AcceptancePermit",
      message: permit,
    });

    const agentStakeApproveHash = await agentWallet.writeContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "approve",
      args: [escrowAddress, budget],
      chain: null,
      account: agent,
    });
    await publicClient.waitForTransactionReceipt({ hash: agentStakeApproveHash });

    const acceptTaskHash = await agentWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "acceptTask",
      args: [permit, permitSignature],
      chain: null,
      account: agent,
    });
    await publicClient.waitForTransactionReceipt({ hash: acceptTaskHash });

    const onChainTask = (await publicClient.readContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "getTask",
      args: [taskIdOnChain],
    })) as { stake: bigint };

    return { taskId, taskIdOnChain, budget, stake: onChainTask.stake };
  }

  async function submitRealResult(params: {
    taskId: string;
    taskIdOnChain: `0x${string}`;
  }): Promise<{ resultHash: `0x${string}`; txHash: `0x${string}` }> {
    const agentWallet = createWalletClient({ account: agent, transport: http(rpcUrl) });
    const resultHash: `0x${string}` = keccak256(
      toBytes(`e2e-result-${params.taskId}-${Date.now()}`),
    );
    const txHash = await agentWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "submitResult",
      args: [params.taskIdOnChain, resultHash],
      chain: null,
      account: agent,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const agentSessionToken = await login(agent);
    const verifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${params.taskId}/result-verifications`,
      cookies: { session_token: agentSessionToken },
      payload: { txHash },
    });
    expect(verifyResponse.statusCode).toBe(200);
    return { resultHash, txHash };
  }

  // `evm_increaseTime`/`evm_mine` are Hardhat-specific test RPC methods,
  // not part of viem's typed EIP-1193 method set — `request` is cast to
  // a loosely-typed signature for these two calls only.
  const rawRequest = (params: { method: string; params: unknown[] }) =>
    (publicClient.request as (args: unknown) => Promise<unknown>)(params);

  async function increaseChainTime(seconds: bigint | number): Promise<void> {
    await rawRequest({ method: "evm_increaseTime", params: [Number(seconds)] });
    await rawRequest({ method: "evm_mine", params: [] });
  }

  // ---------------------------------------------------------------
  // Scenario 1: 正常验收放款 (approveResult)
  // ---------------------------------------------------------------
  let scenario1TxHash: `0x${string}`;
  let scenario1TaskId: string;
  let scenario1AgentId: string;

  it("scenario 1 — normal acceptance: real approveResult pays budget+stake to the agent, stats and chain state all real", async () => {
    const agentId = await insertAgentRow();
    scenario1AgentId = agentId;
    const statsBefore = await agentStats(agentId);
    expect(statsBefore).toEqual({ completed: 0, success: 0, overdue: 0, qualityScore: null });

    const { taskId, taskIdOnChain, budget, stake } = await setupAcceptedTask({
      agentId,
      deliveryWindowSeconds: 7n * 24n * 60n * 60n,
    });
    scenario1TaskId = taskId;
    await submitRealResult({ taskId, taskIdOnChain });

    const agentBalanceBefore = await agentBalance(agent.address);

    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const approveResultHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "approveResult",
      args: [taskIdOnChain],
      chain: null,
      account: requester,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: approveResultHash });
    expect(receipt.status).toBe("success");
    scenario1TxHash = approveResultHash;

    const requesterSessionToken = await login(requester);
    const verifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/settlement-verifications`,
      cookies: { session_token: requesterSessionToken },
      payload: { txHash: approveResultHash },
    });
    expect(verifyResponse.statusCode).toBe(200);
    const verifyBody = verifyResponse.json() as { status: string; confirmations: number };
    expect(verifyBody.status).toBe("RELEASED");

    // Real on-chain balance check.
    const agentBalanceAfter = await agentBalance(agent.address);
    expect(agentBalanceAfter - agentBalanceBefore).toBe(budget + stake);

    // Real DB projection check.
    const { rows: taskRows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(taskRows[0]?.status).toBe("RELEASED");

    const statsAfter = await agentStats(agentId);
    expect(statsAfter).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });

    evidenceLog("scenario 1 — normal acceptance (approveResult)", {
      taskId,
      taskIdOnChain,
      requesterAddress: requester.address,
      agentAddress: agent.address,
      approveResultTxHash: approveResultHash,
      budget,
      stake,
      agentBalanceBefore,
      agentBalanceAfter,
      finalTaskStatus: "RELEASED",
      agentStatsAfter: statsAfter,
    });
  }, 60_000);

  // ---------------------------------------------------------------
  // Scenario 2: 交付超时退款 (claimDeliveryTimeout)
  // ---------------------------------------------------------------
  it("scenario 2 — delivery timeout: real claimDeliveryTimeout refunds budget+stake to the requester after real chain-time fast-forward", async () => {
    const agentId = await insertAgentRow();
    const { taskId, taskIdOnChain, budget, stake } = await setupAcceptedTask({
      agentId,
      deliveryWindowSeconds: 60n,
    });

    await increaseChainTime(70);

    const requesterBalanceBefore = await agentBalance(requester.address);
    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const claimHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "claimDeliveryTimeout",
      args: [taskIdOnChain],
      chain: null,
      account: requester,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: claimHash });
    expect(receipt.status).toBe("success");

    const requesterSessionToken = await login(requester);
    const verifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/settlement-verifications`,
      cookies: { session_token: requesterSessionToken },
      payload: { txHash: claimHash },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect((verifyResponse.json() as { status: string }).status).toBe("REFUNDED");

    const requesterBalanceAfter = await agentBalance(requester.address);
    expect(requesterBalanceAfter - requesterBalanceBefore).toBe(budget + stake);

    const { rows: taskRows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(taskRows[0]?.status).toBe("REFUNDED");

    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 0, overdue: 1, qualityScore: null });

    evidenceLog("scenario 2 — delivery timeout (claimDeliveryTimeout)", {
      taskId,
      taskIdOnChain,
      requesterAddress: requester.address,
      agentAddress: agent.address,
      claimDeliveryTimeoutTxHash: claimHash,
      budget,
      stake,
      requesterBalanceBefore,
      requesterBalanceAfter,
      finalTaskStatus: "REFUNDED",
      agentStatsAfter: stats,
    });
  }, 60_000);

  // ---------------------------------------------------------------
  // Scenario 3: 验收超时放款 (finalizeReviewTimeout, permissionless)
  // ---------------------------------------------------------------
  it("scenario 3 — review timeout: real finalizeReviewTimeout, called by an UNRELATED third wallet, pays budget+stake to the agent", async () => {
    const agentId = await insertAgentRow();
    const { taskId, taskIdOnChain, budget, stake } = await setupAcceptedTask({
      agentId,
      deliveryWindowSeconds: 7n * 24n * 60n * 60n,
    });
    await submitRealResult({ taskId, taskIdOnChain });

    await increaseChainTime(REVIEW_WINDOW_SECONDS + 60);

    const agentBalanceBefore = await agentBalance(agent.address);
    // Permissionless: signed and broadcast by `unrelatedUser`, not the
    // requester and not the agent — proves F-1002's on-chain
    // permissionless design for real.
    const unrelatedWallet = createWalletClient({
      account: unrelatedUser,
      transport: http(rpcUrl),
    });
    // Fund the unrelated wallet with a little ETH for gas — it has
    // never received any from the deployer/faucet accounts yet.
    const deployerWallet = createWalletClient({ account: deployer, transport: http(rpcUrl) });
    const fundGasHash = await deployerWallet.sendTransaction({
      to: unrelatedUser.address,
      value: 10n ** 17n, // 0.1 ETH — comfortably covers one call's gas
      chain: null,
      account: deployer,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundGasHash });

    const finalizeHash = await unrelatedWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "finalizeReviewTimeout",
      args: [taskIdOnChain],
      chain: null,
      account: unrelatedUser,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: finalizeHash });
    expect(receipt.status).toBe("success");

    // Verification itself still requires a session (backend design
    // decision, T-1004 round 1 P1) — any signed-in wallet may submit
    // it, matching the on-chain permissionless call.
    const unrelatedSessionToken = await login(unrelatedUser);
    const verifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/settlement-verifications`,
      cookies: { session_token: unrelatedSessionToken },
      payload: { txHash: finalizeHash },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect((verifyResponse.json() as { status: string }).status).toBe("RELEASED");

    const agentBalanceAfter = await agentBalance(agent.address);
    expect(agentBalanceAfter - agentBalanceBefore).toBe(budget + stake);

    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });

    evidenceLog("scenario 3 — review timeout (finalizeReviewTimeout, permissionless caller)", {
      taskId,
      taskIdOnChain,
      agentAddress: agent.address,
      finalizingCallerAddress: unrelatedUser.address,
      finalizeReviewTimeoutTxHash: finalizeHash,
      budget,
      stake,
      agentBalanceBefore,
      agentBalanceAfter,
      finalTaskStatus: "RELEASED",
      agentStatsAfter: stats,
    });
  }, 60_000);

  // ---------------------------------------------------------------
  // Scenario 4/9: 争议 → 仲裁支持 Agent, and dispute-evidence privacy
  // ---------------------------------------------------------------
  let scenario4TaskId: string;
  let scenario4EvidenceSummary: string;

  it("scenario 4 — dispute, arbitrator supports the Agent: real openDispute + real resolveDispute(true) pay budget+stake to the agent", async () => {
    const agentId = await insertAgentRow();
    const { taskId, taskIdOnChain, budget, stake } = await setupAcceptedTask({
      agentId,
      deliveryWindowSeconds: 7n * 24n * 60n * 60n,
    });
    scenario4TaskId = taskId;
    await submitRealResult({ taskId, taskIdOnChain });

    // Off-chain half: real POST through the real route.
    const requesterSessionToken = await login(requester);
    scenario4EvidenceSummary = `The delivered result for task ${taskId} does not meet the agreed specification — e2e scenario 4.`;
    const openDisputeOffChain = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: requesterSessionToken },
      payload: { reason: "质量不达标", evidenceSummary: scenario4EvidenceSummary },
    });
    expect(openDisputeOffChain.statusCode).toBe(201);
    const { evidenceHash } = openDisputeOffChain.json() as { evidenceHash: `0x${string}` };

    // On-chain half: real openDispute referencing that SAME hash.
    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const openDisputeHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "openDispute",
      args: [taskIdOnChain, evidenceHash],
      chain: null,
      account: requester,
    });
    const openReceipt = await publicClient.waitForTransactionReceipt({
      hash: openDisputeHash,
    });
    expect(openReceipt.status).toBe("success");

    const openVerifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/dispute-open-verifications`,
      cookies: { session_token: requesterSessionToken },
      payload: { txHash: openDisputeHash },
    });
    expect(openVerifyResponse.statusCode).toBe(200);
    expect((openVerifyResponse.json() as { status: string }).status).toBe("DISPUTED");

    // Real arbitrator resolves in the agent's favor.
    const agentBalanceBefore = await agentBalance(agent.address);
    const arbitratorWallet = createWalletClient({ account: arbitrator, transport: http(rpcUrl) });
    const resolveHash = await arbitratorWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "resolveDispute",
      args: [taskIdOnChain, true],
      chain: null,
      account: arbitrator,
    });
    const resolveReceipt = await publicClient.waitForTransactionReceipt({ hash: resolveHash });
    expect(resolveReceipt.status).toBe("success");

    const arbitratorSessionToken = await login(arbitrator);
    const resolveVerifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/dispute-resolve-verifications`,
      cookies: { session_token: arbitratorSessionToken },
      payload: { txHash: resolveHash },
    });
    expect(resolveVerifyResponse.statusCode).toBe(200);
    expect((resolveVerifyResponse.json() as { status: string }).status).toBe("RELEASED");

    const agentBalanceAfter = await agentBalance(agent.address);
    expect(agentBalanceAfter - agentBalanceBefore).toBe(budget + stake);

    const { rows: taskRows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(taskRows[0]?.status).toBe("RELEASED");

    const { rows: disputeRows } = await pool.query<{ status: string; resolution: string }>(
      `SELECT status, resolution FROM disputes WHERE task_id = $1`,
      [taskId],
    );
    expect(disputeRows[0]).toEqual({ status: "RESOLVED", resolution: "SUPPORT_AGENT" });

    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 1, overdue: 0, qualityScore: null });

    evidenceLog(
      "scenario 4 — dispute, arbitrator supports the Agent (openDispute + resolveDispute)",
      {
        taskId,
        taskIdOnChain,
        requesterAddress: requester.address,
        agentAddress: agent.address,
        arbitratorAddress: arbitrator.address,
        evidenceHash,
        openDisputeTxHash: openDisputeHash,
        resolveDisputeTxHash: resolveHash,
        budget,
        stake,
        agentBalanceBefore,
        agentBalanceAfter,
        finalTaskStatus: "RELEASED",
        disputeResolution: "SUPPORT_AGENT",
        agentStatsAfter: stats,
      },
    );
  }, 60_000);

  it("scenario 9 — dispute evidence privacy: real GET /tasks/:taskId/disputes hides evidenceSummary from anonymous/unrelated viewers, reveals it to real participants and the real on-chain arbitrator", async () => {
    // Depends on scenario 4 having already run and populated a real,
    // resolved dispute with real evidence — Vitest runs `it` blocks in
    // this file sequentially by default, matching this Feature's own
    // established convention of chaining real state across `it` blocks
    // within one real-chain e2e suite (T-906 does the same).
    expect(scenario4TaskId).toBeTruthy();

    // Anonymous — no session cookie at all.
    const anonymousResponse = await app.inject({
      method: "GET",
      url: `/tasks/${scenario4TaskId}/disputes`,
    });
    expect(anonymousResponse.statusCode).toBe(200);
    const anonymousBody = anonymousResponse.json() as { evidenceSummary?: string };
    expect(anonymousBody.evidenceSummary).toBeUndefined();

    // An unrelated but genuinely signed-in wallet.
    const unrelatedSessionToken = await login(unrelatedUser);
    const unrelatedResponse = await app.inject({
      method: "GET",
      url: `/tasks/${scenario4TaskId}/disputes`,
      cookies: { session_token: unrelatedSessionToken },
    });
    expect(unrelatedResponse.statusCode).toBe(200);
    expect(
      (unrelatedResponse.json() as { evidenceSummary?: string }).evidenceSummary,
    ).toBeUndefined();

    // The requester — a real participant.
    const requesterSessionToken = await login(requester);
    const requesterResponse = await app.inject({
      method: "GET",
      url: `/tasks/${scenario4TaskId}/disputes`,
      cookies: { session_token: requesterSessionToken },
    });
    expect(requesterResponse.statusCode).toBe(200);
    expect((requesterResponse.json() as { evidenceSummary?: string }).evidenceSummary).toBe(
      scenario4EvidenceSummary,
    );

    // The accepted Agent — the other real participant.
    const agentSessionToken = await login(agent);
    const agentResponse = await app.inject({
      method: "GET",
      url: `/tasks/${scenario4TaskId}/disputes`,
      cookies: { session_token: agentSessionToken },
    });
    expect(agentResponse.statusCode).toBe(200);
    expect((agentResponse.json() as { evidenceSummary?: string }).evidenceSummary).toBe(
      scenario4EvidenceSummary,
    );

    // The REAL on-chain ARBITRATOR_ROLE holder — this exercises a real
    // `hasRole` read against the real deployed contract (access-guard.ts),
    // not a mocked role check.
    const arbitratorSessionToken = await login(arbitrator);
    const arbitratorResponse = await app.inject({
      method: "GET",
      url: `/tasks/${scenario4TaskId}/disputes`,
      cookies: { session_token: arbitratorSessionToken },
    });
    expect(arbitratorResponse.statusCode).toBe(200);
    expect((arbitratorResponse.json() as { evidenceSummary?: string }).evidenceSummary).toBe(
      scenario4EvidenceSummary,
    );
  });

  // ---------------------------------------------------------------
  // Scenario 5: 争议 → 仲裁支持需求方
  // ---------------------------------------------------------------
  it("scenario 5 — dispute, arbitrator supports the requester: real resolveDispute(false) refunds budget+stake to the requester, no overdue increment", async () => {
    const agentId = await insertAgentRow();
    const { taskId, taskIdOnChain, budget, stake } = await setupAcceptedTask({
      agentId,
      deliveryWindowSeconds: 7n * 24n * 60n * 60n,
    });
    await submitRealResult({ taskId, taskIdOnChain });

    const requesterSessionToken = await login(requester);
    const evidenceSummary = `Scenario 5's own evidence for task ${taskId}.`;
    const openDisputeOffChain = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: requesterSessionToken },
      payload: { reason: "质量不达标", evidenceSummary },
    });
    expect(openDisputeOffChain.statusCode).toBe(201);
    const { evidenceHash } = openDisputeOffChain.json() as { evidenceHash: `0x${string}` };

    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const openDisputeHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "openDispute",
      args: [taskIdOnChain, evidenceHash],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: openDisputeHash });
    const openVerifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/dispute-open-verifications`,
      cookies: { session_token: requesterSessionToken },
      payload: { txHash: openDisputeHash },
    });
    expect(openVerifyResponse.statusCode).toBe(200);

    const requesterBalanceBefore = await agentBalance(requester.address);
    const arbitratorWallet = createWalletClient({ account: arbitrator, transport: http(rpcUrl) });
    const resolveHash = await arbitratorWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "resolveDispute",
      args: [taskIdOnChain, false],
      chain: null,
      account: arbitrator,
    });
    const resolveReceipt = await publicClient.waitForTransactionReceipt({ hash: resolveHash });
    expect(resolveReceipt.status).toBe("success");

    const arbitratorSessionToken = await login(arbitrator);
    const resolveVerifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/dispute-resolve-verifications`,
      cookies: { session_token: arbitratorSessionToken },
      payload: { txHash: resolveHash },
    });
    expect(resolveVerifyResponse.statusCode).toBe(200);
    expect((resolveVerifyResponse.json() as { status: string }).status).toBe("REFUNDED");

    const requesterBalanceAfter = await agentBalance(requester.address);
    expect(requesterBalanceAfter - requesterBalanceBefore).toBe(budget + stake);

    const { rows: disputeRows } = await pool.query<{ status: string; resolution: string }>(
      `SELECT status, resolution FROM disputes WHERE task_id = $1`,
      [taskId],
    );
    expect(disputeRows[0]).toEqual({ status: "RESOLVED", resolution: "SUPPORT_REQUESTER" });

    // AC-1008: NOT overdue+1 — a dispute-driven refund is a quality
    // outcome, never conflated with a delivery-timeout refund.
    const stats = await agentStats(agentId);
    expect(stats).toEqual({ completed: 1, success: 0, overdue: 0, qualityScore: null });

    evidenceLog(
      "scenario 5 — dispute, arbitrator supports the requester (openDispute + resolveDispute)",
      {
        taskId,
        taskIdOnChain,
        requesterAddress: requester.address,
        agentAddress: agent.address,
        arbitratorAddress: arbitrator.address,
        evidenceHash,
        openDisputeTxHash: openDisputeHash,
        resolveDisputeTxHash: resolveHash,
        budget,
        stake,
        requesterBalanceBefore,
        requesterBalanceAfter,
        finalTaskStatus: "REFUNDED",
        disputeResolution: "SUPPORT_REQUESTER",
        agentStatsAfter: stats,
      },
    );
  }, 60_000);

  // ---------------------------------------------------------------
  // Scenario 6: 重复 txHash 幂等 (reuses scenario 1's own real txHash)
  // ---------------------------------------------------------------
  it("scenario 6 — idempotent replay: resubmitting scenario 1's own real settlement txHash does not duplicate any side effect", async () => {
    expect(scenario1TxHash).toBeTruthy();
    const { rows: beforeRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chain_transactions WHERE tx_hash = $1`,
      [scenario1TxHash.toLowerCase()],
    );
    expect(beforeRows[0]?.count).toBe("1");
    const statsBefore = await agentStats(scenario1AgentId);

    const requesterSessionToken = await login(requester);
    const replayResponse = await app.inject({
      method: "POST",
      url: `/tasks/${scenario1TaskId}/settlement-verifications`,
      cookies: { session_token: requesterSessionToken },
      payload: { txHash: scenario1TxHash },
    });
    expect(replayResponse.statusCode).toBe(200);
    expect((replayResponse.json() as { status: string }).status).toBe("RELEASED");

    const { rows: afterRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chain_transactions WHERE tx_hash = $1`,
      [scenario1TxHash.toLowerCase()],
    );
    expect(afterRows[0]?.count).toBe("1");

    const statsAfter = await agentStats(scenario1AgentId);
    expect(statsAfter).toEqual(statsBefore);

    evidenceLog("scenario 6 — idempotent replay (same real txHash resubmitted)", {
      taskId: scenario1TaskId,
      replayedTxHash: scenario1TxHash,
      chainTransactionsRowCountBefore: beforeRows[0]?.count,
      chainTransactionsRowCountAfter: afterRows[0]?.count,
      agentStatsBefore: statsBefore,
      agentStatsAfter: statsAfter,
    });
  });

  // ---------------------------------------------------------------
  // Scenario 7: RPC 暂时失败后的恢复
  // ---------------------------------------------------------------
  it("scenario 7 — RPC recovery: a real verification call against an unreachable RPC URL returns 202 RPC_TEMPORARILY_UNAVAILABLE, then succeeds once the real URL is restored", async () => {
    const agentId = await insertAgentRow();
    const { taskId, taskIdOnChain } = await setupAcceptedTask({
      agentId,
      deliveryWindowSeconds: 60n,
    });
    await increaseChainTime(70);

    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const claimHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "claimDeliveryTimeout",
      args: [taskIdOnChain],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: claimHash });

    const requesterSessionToken = await login(requester);

    // Point BACKEND_RPC_URL at a genuinely unreachable local port —
    // `createChainRpcClient()` re-reads this env var at call time
    // (rpc.client.ts's own documented design), so this real route call
    // really does try to reach a dead endpoint, not a simulated failure.
    const deadPort = await getFreePort(); // free right now == nothing listening there
    process.env.BACKEND_RPC_URL = `http://127.0.0.1:${deadPort}`;

    const failedResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/settlement-verifications`,
      cookies: { session_token: requesterSessionToken },
      payload: { txHash: claimHash },
    });
    expect(failedResponse.statusCode).toBe(202);
    const failedBody = failedResponse.json() as { error: { code: string } };
    expect(failedBody.error.code).toBe("RPC_TEMPORARILY_UNAVAILABLE");

    // Restore the real URL and retry the SAME real txHash.
    process.env.BACKEND_RPC_URL = rpcUrl;
    const recoveredResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/settlement-verifications`,
      cookies: { session_token: requesterSessionToken },
      payload: { txHash: claimHash },
    });
    expect(recoveredResponse.statusCode).toBe(200);
    expect((recoveredResponse.json() as { status: string }).status).toBe("REFUNDED");

    evidenceLog("scenario 7 — RPC temporary-failure recovery", {
      taskId,
      claimDeliveryTimeoutTxHash: claimHash,
      firstAttempt: {
        rpcUrl: `http://127.0.0.1:${deadPort}`,
        httpStatus: 202,
        errorCode: "RPC_TEMPORARILY_UNAVAILABLE",
      },
      retryAfterRestoringRealRpcUrl: { rpcUrl, httpStatus: 200, finalTaskStatus: "REFUNDED" },
    });
  });

  // ---------------------------------------------------------------
  // Scenario 8: 评分规则
  // ---------------------------------------------------------------
  it("scenario 8 — ratings: the real requester submits a score exactly once after real settlement; quality_score matches the real normalized value", async () => {
    // Depends on scenario 1's real RELEASED task.
    expect(scenario1TaskId).toBeTruthy();
    const requesterSessionToken = await login(requester);

    // Non-requester attempt — real 403.
    const agentSessionToken = await login(agent);
    const nonRequesterAttempt = await app.inject({
      method: "POST",
      url: `/tasks/${scenario1TaskId}/ratings`,
      cookies: { session_token: agentSessionToken },
      payload: { score: 3 },
    });
    expect(nonRequesterAttempt.statusCode).toBe(403);

    // The real requester submits a real score of 5.
    const submitResponse = await app.inject({
      method: "POST",
      url: `/tasks/${scenario1TaskId}/ratings`,
      cookies: { session_token: requesterSessionToken },
      payload: { score: 5 },
    });
    expect(submitResponse.statusCode).toBe(201);
    const { ratingId } = submitResponse.json() as { ratingId: string };
    expect(ratingId).toBeTruthy();

    // A second submission for the same task — real 409, regardless of
    // who attempts it.
    const secondAttempt = await app.inject({
      method: "POST",
      url: `/tasks/${scenario1TaskId}/ratings`,
      cookies: { session_token: requesterSessionToken },
      payload: { score: 1 },
    });
    expect(secondAttempt.statusCode).toBe(409);

    // score 5 -> (5-1)/4 = 1.0 exactly, per ratings/service.ts's real
    // normalization formula.
    const stats = await agentStats(scenario1AgentId);
    expect(stats.qualityScore).toBeCloseTo(1, 10);

    // Public read, no session required.
    const getResponse = await app.inject({
      method: "GET",
      url: `/tasks/${scenario1TaskId}/ratings`,
    });
    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json() as { ratingId: string; score: number };
    expect(getBody).toMatchObject({ ratingId, score: 5 });

    evidenceLog(
      "scenario 8 — ratings (requester-only, once-per-task, real quality_score recompute)",
      {
        taskId: scenario1TaskId,
        requesterAddress: requester.address,
        ratingId,
        submittedScore: 5,
        nonRequesterAttemptHttpStatus: nonRequesterAttempt.statusCode,
        secondSubmissionAttemptHttpStatus: secondAttempt.statusCode,
        resultingQualityScore: stats.qualityScore,
      },
    );
  });
});
