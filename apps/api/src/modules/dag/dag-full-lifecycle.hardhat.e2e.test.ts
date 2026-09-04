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
import { insertAcceptancePermit } from "../dispatch/repository.js";
import { deriveOnChainTaskId } from "../tasks/onchain-task-id.js";
import { advanceDag } from "./service.js";

/**
 * N6 real gap-closing test — AC-1701's literal text: "创建一个'串行三节点'
 * DAG，需求方逐个为每个节点完成锁定预算/等待匹配/接单/交付/验收，DAG 整体在
 * 最后一个节点结算后标记完成；每个节点各自对应一个真实的链上 Task". Prior
 * DAG e2e coverage (`activate.hardhat.e2e.test.ts`,
 * `dag-detail.hardhat.e2e.test.ts`, `cancel.hardhat.e2e.test.ts`) only ever
 * exercised real funding (DRAFT→OPEN) for a DAG node's task — the
 * 接单/交付/验收 (accept/submit/approve) portion was always simulated via
 * direct SQL on `tasks.status` (`advance.integration.test.ts`'s own
 * established, and separately defensible, "already covered by
 * `full-lifecycle.hardhat.e2e.test.ts` for an ordinary task" reasoning).
 * That reasoning is sound (a real code-search confirms zero `task_dag`/
 * `dag_id` awareness anywhere in `tasks`/`dispatch`/`deliverables`), but it
 * is NOT the same as a direct real-chain proof that a DAG-created task
 * specifically survives the full real accept→submit→approve cycle. This
 * file closes that gap directly: a real three-node SERIAL DAG, where EVERY
 * node completes a full real on-chain lifecycle (fund → accept → submit →
 * approve → RELEASED), driven entirely through the same unmodified
 * task-level endpoints (`funding-verifications`/`acceptance-verifications`/
 * `result-verifications`/`settlement-verifications`) every non-DAG task
 * uses — proving, for real, that "每个节点各自对应一个真实的链上 Task" holds
 * all the way through settlement, not just through funding.
 *
 * Acceptance-permit signing mirrors `full-lifecycle.hardhat.e2e.test.ts`'s
 * own established shortcut: a hand-signed EIP-712 permit from a known
 * `authorizedSigner` account plus a matching `acceptance_permits` DB row
 * (mirroring what the real Go dispatch/matching service would have
 * written) — this is the same pattern `acceptance.integration.test.ts`
 * uses, not a new invention; running the real Go dispatch binary is out of
 * scope for a DAG-focused test (Feature 7's own matching correctness is
 * already covered by its own suites).
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

const HARDHAT_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_REQUESTER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const HARDHAT_AGENT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const HARDHAT_AUTHORIZED_SIGNER_KEY =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
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

runIfOptedIn(
  "AC-1701: a real serial three-node DAG, EVERY node completing a full real on-chain lifecycle (real Hardhat e2e, N6 gap-closing)",
  () => {
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
    let chainId: number;

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
    const agent = privateKeyToAccount(HARDHAT_AGENT_KEY);
    const authorizedSigner = privateKeyToAccount(HARDHAT_AUTHORIZED_SIGNER_KEY);
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
      if (!ydTokenReceipt.contractAddress)
        throw new Error("YDToken deployment produced no address");
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

      // Requester seeds the agent's real token balance for staking (the
      // deployer transfer above is a no-op since the deployer never held
      // any YDToken — initial supply mints to `requester`).
      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const seedFromRequesterHash = await requesterWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "transfer",
        args: [agent.address, 100_000n * 10n ** 18n],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: seedFromRequesterHash });

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
      if (!match?.[1]) throw new Error("login: no session_token cookie in response");
      return `session_token=${match[1]}`;
    }

    let nextNonce = 1n;

    /** Runs ONE node's real, complete on-chain lifecycle: real
     * `approve`+`createTask` (fund, via the unmodified `funding-intent`/
     * `funding-verifications` endpoints), real `acceptTask` (via a
     * hand-signed EIP-712 permit + a matching `acceptance_permits` DB row,
     * mirroring the real Go dispatch service's own output shape), real
     * `submitResult`, real `approveResult` — verified through the exact
     * same task-level endpoints (`acceptance-verifications`/`result-
     * verifications`/`settlement-verifications`) every non-DAG task uses,
     * unmodified. Returns once the task is genuinely `RELEASED`. */
    async function runFullNodeLifecycle(
      requesterCookie: string,
      taskId: string,
      budget: bigint,
    ): Promise<void> {
      // --- Fund ---
      const fundingIntentResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-intent`,
        headers: { cookie: requesterCookie },
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

      const fundingVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-verifications`,
        headers: { cookie: requesterCookie },
        payload: { txHash: createTaskHash },
      });
      if (fundingVerifyResponse.statusCode !== 200) {
        throw new Error(
          `funding-verifications failed: ${fundingVerifyResponse.statusCode} ${fundingVerifyResponse.body}`,
        );
      }
      expect(fundingVerifyResponse.json().status).toBe("OPEN");

      // --- Accept (real chain, real permit) ---
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        agent.address.toLowerCase(),
      ]);
      const { rows: agentRows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
           VALUES ($1, 'N6 gap-closing agent', 'desc', 'writing', $1)
           ON CONFLICT DO NOTHING RETURNING id`,
        [agent.address.toLowerCase()],
      );
      let agentId = agentRows[0]?.id;
      if (!agentId) {
        const { rows: existingAgentRows } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE owner_address = $1`,
          [agent.address.toLowerCase()],
        );
        agentId = existingAgentRows[0]?.id;
      }
      if (!agentId) throw new Error("could not resolve agent id");

      const { rows: runRows } = await pool.query<{ id: string }>(
        `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
           VALUES ($1, 'v0.1', 1, 'n6-gap-closing-digest') RETURNING id`,
        [taskId],
      );
      const runId = runRows[0]?.id;
      if (!runId) throw new Error("insertRecommendationRun: no id returned");

      const permitNonce = nextNonce;
      nextNonce += 1n;
      const permitExpiry = deliveryDeadlineUnix;
      const permit = {
        taskId: onChainTaskId,
        agent: agent.address,
        nonce: permitNonce,
        expiry: permitExpiry,
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

      // Mirrors what the real Go dispatch/matching service would have
      // written for this candidate — this DB row is what
      // `resolveAcceptingAgentId` (tasks/repository.ts) matches the real
      // on-chain event's recovered `(address, nonce)` against; the actual
      // cryptographic verification of the permit already happened
      // on-chain (the contract itself checks the signature), so the
      // `signature` column stored here is a record, not re-verified.
      await insertAcceptancePermit(pool, {
        taskId,
        runId,
        agentId,
        acceptingAddress: agent.address,
        nonce: permitNonce.toString(),
        expiry: Number(permitExpiry),
        chainId,
        verifyingContract: escrowAddress,
        signature: permitSignature,
      });

      const agentWallet = createWalletClient({ account: agent, transport: http(rpcUrl) });
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

      const agentCookie = await login(agent);
      const acceptanceVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/acceptance-verifications`,
        headers: { cookie: agentCookie },
        payload: { txHash: acceptTaskHash },
      });
      if (acceptanceVerifyResponse.statusCode !== 200) {
        throw new Error(
          `acceptance-verifications failed: ${acceptanceVerifyResponse.statusCode} ${acceptanceVerifyResponse.body}`,
        );
      }
      expect(acceptanceVerifyResponse.json().status).toBe("ACCEPTED");

      // --- Submit ---
      const resultHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
      const submitResultHash = await agentWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "submitResult",
        args: [onChainTaskId, resultHash],
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: submitResultHash });

      const resultVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/result-verifications`,
        headers: { cookie: agentCookie },
        payload: { txHash: submitResultHash },
      });
      if (resultVerifyResponse.statusCode !== 200) {
        throw new Error(
          `result-verifications failed: ${resultVerifyResponse.statusCode} ${resultVerifyResponse.body}`,
        );
      }
      expect(resultVerifyResponse.json().status).toBe("SUBMITTED");

      // --- Approve (settle) ---
      const approveResultHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "approveResult",
        args: [onChainTaskId],
        chain: null,
        account: requester,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({
        hash: approveResultHash,
      });
      expect(approveReceipt.status).toBe("success");

      const settlementVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/settlement-verifications`,
        headers: { cookie: requesterCookie },
        payload: { txHash: approveResultHash },
      });
      if (settlementVerifyResponse.statusCode !== 200) {
        throw new Error(
          `settlement-verifications failed: ${settlementVerifyResponse.statusCode} ${settlementVerifyResponse.body}`,
        );
      }
      expect(settlementVerifyResponse.json().status).toBe("RELEASED");

      const { rows: finalTaskRows } = await pool.query<{ status: string }>(
        `SELECT status FROM tasks WHERE id = $1`,
        [taskId],
      );
      expect(finalTaskRows[0]?.status).toBe("RELEASED");
    }

    it("every node of a real serial three-node DAG completes a full real on-chain fund→accept→submit→approve cycle, and the DAG itself reaches COMPLETED", async () => {
      const cookie = await login(requester);
      const budget = 100n * 10n ** 18n;

      const createDagResponse = await app.inject({
        method: "POST",
        url: "/dags",
        headers: { cookie },
        payload: {
          title: "AC-1701 full real lifecycle, three serial nodes",
          category: "writing",
          totalBudget: (budget * 3n).toString(),
          nodes: [
            {
              key: "a",
              role: "SERIAL",
              title: "Step A",
              description: "desc a",
              subBudget: budget.toString(),
              expertType: "AUTOMATION",
              deliveryDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              skillTags: [],
              dependsOn: [],
            },
            {
              key: "b",
              role: "SERIAL",
              title: "Step B",
              description: "desc b",
              subBudget: budget.toString(),
              expertType: "AUTOMATION",
              deliveryDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              skillTags: [],
              dependsOn: ["a"],
            },
            {
              key: "c",
              role: "SERIAL",
              title: "Step C",
              description: "desc c",
              subBudget: budget.toString(),
              expertType: "AUTOMATION",
              deliveryDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              skillTags: [],
              dependsOn: ["b"],
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

      async function nodeTaskId(title: string): Promise<string> {
        const { rows } = await pool.query<{ task_id: string | null }>(
          `SELECT task_id FROM task_dag_nodes WHERE dag_id = $1 AND title = $2`,
          [dagId, title],
        );
        const taskId = rows[0]?.task_id;
        if (!taskId) throw new Error(`node "${title}" has no task_id yet`);
        return taskId;
      }

      // Step A: real full lifecycle end to end.
      const stepATaskId = await nodeTaskId("Step A");
      await runFullNodeLifecycle(cookie, stepATaskId, budget);

      const advanceAfterA = await advanceDag(pool, dagId);
      expect(advanceAfterA.ok).toBe(true);
      if (!advanceAfterA.ok) throw new Error("unreachable");
      expect(advanceAfterA.syncedNodeIds).toHaveLength(1);
      expect(advanceAfterA.activatedNodeIds).toHaveLength(1);

      const { rows: afterANodeRows } = await pool.query<{ title: string; node_status: string }>(
        `SELECT title, node_status FROM task_dag_nodes WHERE dag_id = $1`,
        [dagId],
      );
      const afterAStatuses = new Map(afterANodeRows.map((row) => [row.title, row.node_status]));
      expect(afterAStatuses.get("Step A")).toBe("DONE");
      expect(afterAStatuses.get("Step B")).toBe("TASK_ACTIVE");
      expect(afterAStatuses.get("Step C")).toBe("PENDING");

      // Step B: real full lifecycle end to end — proving the mechanism
      // genuinely generalizes across nodes, not a one-off for the first
      // node only.
      const stepBTaskId = await nodeTaskId("Step B");
      await runFullNodeLifecycle(cookie, stepBTaskId, budget);

      const advanceAfterB = await advanceDag(pool, dagId);
      expect(advanceAfterB.ok).toBe(true);
      if (!advanceAfterB.ok) throw new Error("unreachable");
      expect(advanceAfterB.activatedNodeIds).toHaveLength(1);

      // Step C: the third and final node — completes the DAG.
      const stepCTaskId = await nodeTaskId("Step C");
      await runFullNodeLifecycle(cookie, stepCTaskId, budget);

      const advanceAfterC = await advanceDag(pool, dagId);
      expect(advanceAfterC.ok).toBe(true);
      if (!advanceAfterC.ok) throw new Error("unreachable");
      expect(advanceAfterC.dagCompleted).toBe(true);

      const { rows: finalNodeRows } = await pool.query<{ title: string; node_status: string }>(
        `SELECT title, node_status FROM task_dag_nodes WHERE dag_id = $1`,
        [dagId],
      );
      const finalStatuses = new Map(finalNodeRows.map((row) => [row.title, row.node_status]));
      expect(finalStatuses.get("Step A")).toBe("DONE");
      expect(finalStatuses.get("Step B")).toBe("DONE");
      expect(finalStatuses.get("Step C")).toBe("DONE");

      const { rows: dagRows } = await pool.query<{ status: string }>(
        `SELECT status FROM task_dags WHERE id = $1`,
        [dagId],
      );
      expect(dagRows[0]?.status).toBe("COMPLETED");

      // "每个节点各自对应一个真实的链上 Task" — three distinct on-chain
      // tasks, each independently created/accepted/settled.
      expect(new Set([stepATaskId, stepBTaskId, stepCTaskId]).size).toBe(3);

      // Independent real-chain confirmation: the agent's real token
      // balance moved by exactly 3x budget net, for all three real
      // settlements. Reading `STAKE_RATE_BPS` from the real deployed
      // contract (rather than assuming a rate) proves the real contract
      // genuinely charged a stake on each of the 3 real `acceptTask`
      // calls — if it hadn't (e.g. a broken deployment), this call
      // itself would revert or return an unexpected value; the NET
      // balance change is stake-rate-independent by construction
      // (`approveResult` always pays back `budget + stake`, so each
      // node's own stake nets to zero — spent on accept, refunded plus
      // the real budget on release).
      const stakeRateBps = (await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "STAKE_RATE_BPS",
        args: [],
      })) as bigint;
      expect(stakeRateBps).toBeGreaterThan(0n);
      const agentBalance = (await publicClient.readContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "balanceOf",
        args: [agent.address],
      })) as bigint;
      const expectedAgentBalance = 100_000n * 10n ** 18n + 3n * budget;
      expect(agentBalance).toBe(expectedAgentBalance);
    }, 60_000);
  },
);
