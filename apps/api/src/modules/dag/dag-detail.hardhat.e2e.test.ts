import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { deriveOnChainTaskId } from "../tasks/onchain-task-id.js";

/**
 * T-1707 — real-chain proof for AC-1705's "资金守恒（链上真实转账总额与聚合
 * 视图一致）": a two-node DAG where one node is funded and then really
 * cancelled (a real `cancelTask` refund) while the other stays funded and
 * unresolved. The real on-chain token balance movement (the requester's
 * `YDToken` balance) must match `GET /dags/:dagId`'s own `budget`
 * projection exactly — not just internally self-consistent arithmetic
 * (that's `budget-summary.test.ts`'s job), but consistent with what
 * actually moved on a real chain.
 *
 * Layered opt-in identical to every other `*.hardhat.e2e.test.ts` file:
 * `RUN_DB_INTEGRATION_TESTS=1` + `TEST_DATABASE_URL` +
 * `RUN_HARDHAT_E2E_TESTS=1`.
 */
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_HARDHAT_E2E_TESTS === "1"
    ? describe
    : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const contractsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../contracts",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const HARDHAT_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_REQUESTER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const HARDHAT_ARBITRATOR_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

const REVIEW_WINDOW_SECONDS = 259_200;

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

runIfOptedIn("GET /dags/:dagId budget projection (real Hardhat e2e, AC-1705, T-1707)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let hardhatProcess: ChildProcessByStdio<null, Readable, Readable>;
  let hardhatStderr = "";
  let rpcUrl: string;
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
    if (!(key in previousEnv)) previousEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const deployer = privateKeyToAccount(HARDHAT_DEPLOYER_KEY);
  const requester = privateKeyToAccount(HARDHAT_REQUESTER_KEY);
  const arbitrator = privateKeyToAccount(HARDHAT_ARBITRATOR_KEY);

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);

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
    const chainId = await publicClient.getChainId();
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
      args: [ydTokenAddress, deployer.address, REVIEW_WINDOW_SECONDS, arbitrator.address],
      chain: null,
    });
    const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash });
    if (!escrowReceipt.contractAddress)
      throw new Error("TaskEscrow deployment produced no address");
    escrowAddress = escrowReceipt.contractAddress;
    setManagedEnv("TASK_ESCROW_ADDRESS", escrowAddress);

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
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  async function login(): Promise<string> {
    const nonceResponse = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address: requester.address },
    });
    const { nonce, issuedAt, expiresAt } = nonceResponse.json();
    const message = buildSignInMessage({
      domain: "localhost",
      address: requester.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await requester.signMessage({ message });
    const verifyResponse = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: requester.address, signature, nonce },
    });
    const setCookie = verifyResponse.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = /session_token=([^;]+)/.exec(String(header));
    if (!match?.[1]) throw new Error("login: no session_token cookie in response");
    return `session_token=${match[1]}`;
  }

  async function fundNode(cookie: string, taskId: string, budget: bigint): Promise<void> {
    const fundingIntentResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/funding-intent`,
      headers: { cookie },
    });
    expect(fundingIntentResponse.statusCode).toBe(200);

    const onChainTaskId = deriveOnChainTaskId(taskId);
    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });

    const approveHash = await requesterWallet.writeContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "approve",
      args: [escrowAddress, budget],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const { rows: taskDeadlineRows } = await pool.query<{ delivery_deadline: Date }>(
      `SELECT delivery_deadline FROM tasks WHERE id = $1`,
      [taskId],
    );
    const deliveryDeadline = taskDeadlineRows[0]?.delivery_deadline;
    if (!deliveryDeadline) throw new Error("no delivery_deadline persisted for task");
    const deliveryDeadlineUnix = BigInt(Math.floor(deliveryDeadline.getTime() / 1000));
    const createTaskHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "createTask",
      args: [onChainTaskId, ydTokenAddress, budget, deliveryDeadlineUnix],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: createTaskHash });

    const verifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/funding-verifications`,
      headers: { cookie },
      payload: { txHash: createTaskHash },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json().status).toBe("OPEN");
  }

  it("AC-1705: the budget projection's buckets match the real, independently-observed on-chain token balance movement", async () => {
    const cookie = await login();
    const budgetPerNode = 200n * 10n ** 18n;

    const balanceBeforeAnything = await publicClient.readContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "balanceOf",
      args: [requester.address],
    });

    const createDagResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "AC-1705 fund conservation",
        category: "writing",
        totalBudget: (budgetPerNode * 2n).toString(),
        nodes: [
          {
            key: "a",
            role: "PARALLEL",
            title: "Node A (stays locked)",
            description: "desc a",
            subBudget: budgetPerNode.toString(),
            expertType: "AUTOMATION",
            deliveryDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            skillTags: [],
            dependsOn: [],
          },
          {
            key: "b",
            role: "PARALLEL",
            title: "Node B (real cancel/refund)",
            description: "desc b",
            subBudget: budgetPerNode.toString(),
            expertType: "AUTOMATION",
            deliveryDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            skillTags: [],
            dependsOn: [],
          },
        ],
      },
    });
    expect(createDagResponse.statusCode).toBe(201);
    const dagId = createDagResponse.json().id as string;

    await app.inject({ method: "POST", url: `/dags/${dagId}/activate`, headers: { cookie } });

    const { rows: nodeRows } = await pool.query<{ id: string; title: string; task_id: string }>(
      `SELECT id, title, task_id FROM task_dag_nodes WHERE dag_id = $1`,
      [dagId],
    );
    const nodeA = nodeRows.find((row) => row.title === "Node A (stays locked)");
    const nodeB = nodeRows.find((row) => row.title === "Node B (real cancel/refund)");
    if (!nodeA?.task_id || !nodeB?.task_id) throw new Error("both nodes should have a task_id");

    await fundNode(cookie, nodeA.task_id, budgetPerNode);
    await fundNode(cookie, nodeB.task_id, budgetPerNode);

    // Independently observed, real on-chain effect of BOTH real
    // `createTask` calls: the requester's own token balance really
    // decreased by 2x budgetPerNode.
    const balanceAfterBothFunded = await publicClient.readContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "balanceOf",
      args: [requester.address],
    });
    expect((balanceBeforeAnything as bigint) - (balanceAfterBothFunded as bigint)).toBe(
      budgetPerNode * 2n,
    );

    const onChainTaskIdB = deriveOnChainTaskId(nodeB.task_id);
    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const cancelHash = await requesterWallet.writeContract({
      address: escrowAddress,
      abi: escrowAbi as never,
      functionName: "cancelTask",
      args: [onChainTaskIdB],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: cancelHash });

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/nodes/${nodeB.id}/cancel`,
      headers: { cookie },
      payload: { txHash: cancelHash },
    });
    expect(cancelResponse.statusCode).toBe(200);

    // Independently observed, real on-chain effect of the real
    // `cancelTask` refund: the requester's token balance really went back
    // up by exactly budgetPerNode (100% refund, TaskEscrow.sol's own
    // documented cancelTask behavior).
    const balanceAfterCancel = await publicClient.readContract({
      address: ydTokenAddress,
      abi: ydTokenAbi as never,
      functionName: "balanceOf",
      args: [requester.address],
    });
    expect((balanceAfterCancel as bigint) - (balanceAfterBothFunded as bigint)).toBe(budgetPerNode);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/dags/${dagId}`,
      headers: { cookie },
    });
    expect(detailResponse.statusCode).toBe(200);
    const budget = detailResponse.json().budget;

    // The projection's own buckets, computed purely from
    // task_dag_nodes/tasks, must match what the chain independently shows
    // actually happened: A's budget still locked in escrow, B's budget
    // refunded — nothing released yet (neither node was ever accepted).
    expect(budget).toEqual({
      totalBudget: (budgetPerNode * 2n).toString(),
      releasedBudget: "0",
      refundedBudget: budgetPerNode.toString(),
      activeLockedBudget: budgetPerNode.toString(),
      notYetFundedBudget: "0",
    });

    // Cross-check: refundedBudget + activeLockedBudget (the DAG's own
    // still-outstanding funds) plus the requester's net real balance
    // change (-budgetPerNode overall: paid out 2x, got 1x back) accounts
    // for the exact same budgetPerNode still actually escrowed on-chain.
    const netRealOutflow = (balanceBeforeAnything as bigint) - (balanceAfterCancel as bigint);
    expect(netRealOutflow).toBe(BigInt(budget.activeLockedBudget));
  }, 30_000);
});
