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
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { deriveOnChainTaskId } from "../tasks/onchain-task-id.js";

/**
 * T-1702 — real-chain proof for AC-1701's core claim ("第一个节点真实创建链上
 * 任务"): a DAG node created by `POST /dags/:dagId/activate` is not just a
 * DB row shaped like a task — it genuinely integrates with the EXISTING,
 * unmodified Feature 6 funding flow (`POST /tasks/:taskId/funding-
 * verifications`) against a real deployed `TaskEscrow`. Reuses the same
 * real Hardhat + real deployed-contract infrastructure
 * `full-lifecycle.hardhat.e2e.test.ts` (T-1007) established, trimmed to
 * just what this one scenario needs (no acceptance/settlement — that's
 * T-1703+'s scope, already real-e2e-tested elsewhere for the underlying
 * single-task mechanics this reuses unchanged).
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
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, schema_migrations CASCADE";

// Same well-known deterministic Hardhat Network default accounts T-1007
// already uses — publicly documented, hold no real value.
const HARDHAT_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_REQUESTER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const HARDHAT_ARBITRATOR_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

const REVIEW_WINDOW_SECONDS = 259_200; // 72h — matches T-906/T-1007's own deployment.

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

runIfOptedIn("POST /dags/:dagId/activate (real Hardhat e2e, T-1702)", () => {
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

  it("a DAG node's real task, created by activation, accepts a real approve+createTask through the UNCHANGED existing funding-verification endpoint", async () => {
    const cookie = await login();

    const budget = 1_000n * 10n ** 18n;
    const createDagResponse = await app.inject({
      method: "POST",
      url: "/dags",
      headers: { cookie },
      payload: {
        title: "Real chain DAG",
        category: "writing",
        totalBudget: budget.toString(),
        nodes: [
          {
            key: "a",
            role: "SERIAL",
            title: "Real chain node",
            description: "desc",
            subBudget: budget.toString(),
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

    const activateResponse = await app.inject({
      method: "POST",
      url: `/dags/${dagId}/activate`,
      headers: { cookie },
    });
    expect(activateResponse.statusCode).toBe(200);

    const { rows } = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM task_dag_nodes WHERE dag_id = $1`,
      [dagId],
    );
    const taskId = rows[0]?.task_id;
    if (!taskId) throw new Error("no task_id linked after activation");

    // The unchanged Feature 6 DRAFT -> AWAITING_FUNDING transition, before
    // funding-verifications (AWAITING_FUNDING -> OPEN) can accept the real
    // on-chain createTask below.
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

    // The on-chain deliveryDeadline must match `tasks.delivery_deadline`
    // EXACTLY — verifyFunding compares the real decoded event against the
    // value already persisted (the node's own deliveryDeadline, set at DAG
    // creation), not an arbitrary value computed here.
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

    // The real proof: this is the SAME, unmodified endpoint every non-DAG
    // task's funding goes through (Feature 6) — no DAG-specific server
    // code runs here at all.
    const verifyResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/funding-verifications`,
      headers: { cookie },
      payload: { txHash: createTaskHash },
    });
    if (verifyResponse.statusCode !== 200) {
      throw new Error(
        `funding-verifications failed: ${verifyResponse.statusCode} ${verifyResponse.body}`,
      );
    }
    expect(verifyResponse.json().status).toBe("OPEN");

    const { rows: taskRows } = await pool.query<{ status: string; funding_tx_hash: string }>(
      `SELECT status, funding_tx_hash FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(taskRows[0]?.status).toBe("OPEN");
    expect(taskRows[0]?.funding_tx_hash).toBe(createTaskHash);

    // Independent real-chain confirmation the backend's own verification
    // didn't just trust the DB: the real transaction receipt itself
    // succeeded on-chain (status 'success'), against the real deployed
    // TaskEscrow, for the exact createTaskHash the backend verified.
    const receipt = await publicClient.getTransactionReceipt({ hash: createTaskHash });
    expect(receipt.status).toBe("success");
    expect(receipt.to?.toLowerCase()).toBe(escrowAddress.toLowerCase());
  }, 30_000);
});
